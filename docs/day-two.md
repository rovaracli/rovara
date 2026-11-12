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
`--slack-image`, or else from that tag's `release.json` on GitHub. An install that records the Team record
needs an embedder image too: a tag whose `release.json` names none keeps the image the stack already runs,
or takes `--embedder-image <account>.dkr.ecr.<region>.amazonaws.com/<repo>@sha256:<digest>` (an image in your
own registry, pinned by digest).

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

`set` shows the change and asks first (`--yes` skips the question). Only `--yes` answers for you: in a terminal it
prompts, and with no terminal (a pipe or a script) it reads one line from stdin, where `y` or `yes` applies and anything
else, an empty line or a closed stdin declines ("this change needs confirmation: run it in a terminal, or pass
`--yes`"). `agentx config set <key> <value> --preview` prints the change set and stops without applying it (for the
settings that change a stack). With this computer's admin
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
| `liveFix.enabled` | stack parameter LiveFixEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 turns on Fix with agent (a person who can use an error's task asks for a diagnosis: an AI explains what went wrong and proposes fixes; it applies nothing, and a settings change is applied only when a project maintainer presses "Apply this change": it is saved at once as that maintainer's own ordinary save, after Rovara checks that the setting and every quote are still as the diagnosis said, and that a dev container file is in the repository). 0 answers "not found" on every diagnosis route. Deploy the broker and the chat service first, then set 1; to roll back, set 0. Both tiers run on an AI source billed to your company, your own provider or Rovara's metered AI, and are paid by your company exactly as its tasks are (the light one by the person's or project's budgets, a key capped at 25 cents; the deep one as any task); Rovara pays for none. With no provider connected, the diagnosis is not offered and says "Diagnosis uses your company's AI provider. Connect one in Settings to turn it on." Named environments only |
| `proofEvidence.enabled` | stack parameter ProofEvidenceEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 gathers the evidence of each task's checks (test totals and names, the worker's report of what was selected) and shows it: counts, a mocked/not-run list and a link on the pull request, an Evidence tab and a download behind sign-in on the task page. Data that looks personal or names production is dropped before anything is stored or posted. 0 gathers, posts and serves nothing new. Deploy the worker image that carries `task.evidenceCapture.v1` first, then the broker, then set 1; to roll back, set 0. Named environments only |
| `decisionCards.enabled` | stack parameter DecisionCardsEnabled on agentx-<env>-control-plane | 1 (from 0.5.9: new installs start at 1, and the upgrade to 0.5.9 sets 1 once on an existing install, even one set to 0; a later upgrade keeps what you set after it. Turn them off again with `agentx config set decisionCards.enabled 0`) | 0 or 1; 1 mounts the decision card routes (`/v1/app/decisions*`) and answers a Slack card press; medium and high-risk decisions are then made only in the app, high-risk ones on their card after a recent sign-in with the email code (never GitHub). 0 is the emergency off: it answers "not found" on every card route, and the medium and high-risk rules do not apply. Named environments only |
| `testEnvironment.enabled` | stack parameter TestEnvironmentEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 turns on the project test environment: Rovara proposes it from the default branch's files, a maintainer proves it with the setup check and approves it, and later tasks run its checks (selected tests where a nightly map allows, the whole suite otherwise), name it in the evidence, and a nightly full run is scheduled for projects that turn it on. Deploy the worker image that carries `task.testEnvDetect.v1` and `task.testEnvironment.v1` first, then the broker, then set 1; to roll back, set 0. Production accounts and hosts are refused wherever the company lists them. Named environments only |
| `learnedLessons.enabled` | stack parameter LearnedLessonsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets approved lessons be loaded into an agent as advice for its Understand, Plan, Plan-check, Implement and Review steps (a worker image that carries `task.learnedContext.v1` must be deployed; an older worker is sent none). It needs the Team record and is a separate switch from it: with 0, no lesson is loaded, recorded or sent to an agent, even where the Team record is on and a project's learning mode is On. Named environments only; a released install never has it |
| `savedEnv.enabled` | stack parameter SavedEnvEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets a project's proven setup be built into a saved image (an ECR repository per org and project, encrypted, last 3 kept, rebuilt at most every 7 days) and used by tasks, which fall back to a fresh setup on any problem. Deploy the registry roles and the worker image first. Registry-wide scan on push is separate and off (`-c agentxSavedEnvRegistryScan=on`). |
| `ui.forceOff` | stack parameter UiFlagsForceOff on agentx-<env>-control-plane | none | `none`, `all`, or screen names joined by a hyphen (`health-setup`): the screens still being finished, `health`, `setup`, `publish`, `billing`, `agreement` and `companies` (all off by default until they are finished). Holds those screens back for EVERY company on the install, whatever a company chose, and wins over previews; `all` means all of these. This is the operator's install-wide kill switch and needs a stack update. **The finished screens can no longer be turned off** (decision 125, release 0.5.15): look, nav, home, work, spending, leadingHeader, insights and continue have no old screen left, by this switch or by a company (Settings > Old screens is gone). A value set before 0.5.15 that still names one of them keeps working: the broker skips those names and keeps the rest of the list (`look-health` holds back `health` only), and `agentx config set ui.forceOff` refuses them with that reason. Any other name the broker cannot read (a typo, an unknown name) turns every remaining screen off. **Rollout and rollback:** while the parameter is unset (an upgrade that has not reached the control plane yet) there is no override, the same as `none`. A broker from before 0.5.15 that is rolled back to reads the names it knows from the company rows this release wrote: a finished screen's name is never written by this release, and an older broker reads an absent name as off, so after a rollback to 0.5.14 or earlier every company gets that release's old screens again (its own app, which still has them), exactly as before the upgrade; a choice a company stored with that older broker for one of these names is kept in the row until this release's next change to the company's screens drops it. An older app on this broker finds no finished-screen names in the navigation answer and reads them as off, so it shows its own old screens, which still work. Insights' data still has its own switch, `insights.enabled` (`in`): with it off the Insights page says Insights isn't turned on for the company yet and there is no navigation entry. |
| `slack.explicitMembers` | stack parameter SlackExplicitMembers on agentx-<env>-control-plane | 1 | `1`, `warn` or `0`; on a hosted (cloud) install only. `1`: a Slack person who is not an explicit, current member of the company (not removed, not banned; a person merged into a member counts as that member) is no longer served as an implicit member. They get a plain reply in Slack: ask a Rovara admin to add you, or link your Slack account. `warn`: today's access is kept and each such person gets one direct message (once) that a membership will soon be needed; use it first on an install whose Slack people were never added, then move to `1`. `0`: today's behaviour exactly (the rollback). **Order for the 0.5.14 upgrade:** the parameter is new, so `agentx config set slack.explicitMembers warn` can only run AFTER `agentx upgrade` has added it (`config set` refuses on a stack that lacks it), and `agentx upgrade` takes no override for it. The upgrade therefore starts at the default `1`: from the moment it finishes, a Slack person with no membership is refused until you run `agentx config set slack.explicitMembers warn` (do it straight away if you want the warning window; it takes one change set). Deploy the Slack service in the same upgrade as the broker or before it: an older Slack service answers a refused person only after its retries, with the raw refusal text. **Release note 0.5.14:** a Slack identity that holds its own member record but was merged into a person with no record is now refused under `1` (the surviving record decides); check for such merges before moving from `warn` to `1`. A person who is not an explicit, current member also can no longer stop a task from a Slack thread (they get the same private notice). An absent or unknown value counts as `1`. A single-org install has no memberships to ask for and is unchanged. Named environments only |
| `scriptTokens.enabled` | stack parameter ScriptTokensEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets people make script tokens in the app (Your account, Script tokens) so their scripts and CI can read and start their own tasks on chosen projects. See [script-tokens.md](script-tokens.md). |
| `standingInstructions.enabled` | stack parameter StandingInstructionsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 moves a project's "How we work" from the user message into the system prompt of every step, in one block with the company's rules and the wording that says higher sections win (turn on only after the worker image that lists task.standingInstructions.v1 is deployed: an older worker is refused the step). 0: "How we work" reaches the step as it always did. |
| `teamRecord.enabled` | stack parameter TeamRecordEnabled on agentx-<env>-control-plane (once built) | 0 | 0 or 1; the Team record (the sources a project learns from, its lessons and the team record search). The first `1` only records the choice in `/agentx/<env>/team-record`: the next `agentx --env <env> upgrade --source <checkout>` builds its storage (a table, vector and lake buckets and schedules; a source install only), and every later upgrade, diff and init keeps it. After that, `0` pauses it and `1` resumes it. Paused, nothing new is captured, read, searched or learned (the app says the record is paused), while person and project erasure, source removals, Slack deletes, the raw-text expiry and the archiver keep running over the stored record. An install built by hand with `-c agentxTeamRecord=enabled` must run `agentx config set teamRecord.enabled 1` once before its next upgrade: before this setting the CLI never passed that context, so an upgrade synthesized the record away (its retained storage left outside the stack, which the upgrade's data guard refuses and now names). An older `agentx` (before this setting) still synthesizes without the context: its upgrade's data guard stops on the record's resources, so upgrade with this release's CLI. `teamRecord.options` must be confirmed before the first `1` (`default`, or `embeddingModelId=...;kmsKeyArn=...;lake=true|false;athenaUsers=...;enterpriseWorkspaceId=...`, the synth's own `agentxTeamRecord<Option>` values; Enterprise needs `enterpriseWorkspaceId`); every cdk command passes them back, and they can't be changed once the record is built. Until it is built the web app says "The team record isn't set up here yet" with this cause |
| `teamRecord.options` | SSM /agentx/<env>/team-record (options) | not confirmed | `default`, or `name=value` pairs separated by `;` (kmsKeyArn, lake, athenaUsers, enterpriseWorkspaceId; `embeddingModelId` is retired: the record embeds with the built-in self-hosted embedder). Confirmed once, before `teamRecord.enabled 1`; passed to every upgrade; refused once the record is built |
| `teamRecord.embedderImage` | stack parameter EmbedderImageUri on agentx-<env>-control-plane (once the record is built) | (the release's) | A private ECR image in this account and region pinned by digest (`<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>`): the self-hosted embedder (`environments/embedder`, Qwen3-Embedding-0.6B for the record, bge-small for lessons; weights baked in, no network, no Bedrock). The release names its own embedder image and `agentx upgrade` passes it, so you do not set this; it is for a release that carries none, or a test. There is no `none`: the Team record cannot search without it, an upgrade with the record on to a release without the image is refused, and so is a stack without one. The function runs in a network with no route out. Changing the model (a new `spec`) names a new vector index; a row whose raw text is still kept (30 days) is embedded again by a job every 15 minutes, and a row whose text expired stays found by keyword only. The first upgrade to this embedder deletes each workspace's index of the Titan era (its vectors cannot be searched with the new model, and an erase would not have reached them). |
| `designReview.enabled` | stack parameter DesignReviewEnabled on agentx-<env>-control-plane | 0 | 0 or 1; the environment's master switch for design review, an operator's emergency off, not a product setting. With 1, fresh-context reviewers check the design of a Full task before a person approves it, but only for a project where a company admin has allowed design review and the project's mode is not Off: both are set in How we work (the company page has "Design review allowed", which needs a second admin or the only owner, and the stricter-only rules; once it is allowed, each project's maintainers choose Off, Auto or Always on the project's How we work page, and a project starts Off). Setting 0, or an admin turning design review off for the company or a project, also stops a review already under way at its next step (the next round or planner run): it ends as not run ("switched off") and the design goes to the person as it stands. A review a person asked for with "design first" goes on while design review is allowed. Nothing is approved for anyone. With 0 nothing about design review is read or changed |
| `secondReview.enabled` | stack parameter SecondReviewEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 allows an added second review of a task's code by a model of a different AI company than the one that wrote it (Amazon Nova Pro or Premier first, then other companies' models). A project or company then chooses `off`, `shadow` (the second opinion is recorded and shown on the task page, never blocks and is never on the pull request) or `on` (its blocking findings send the work back like the first review's); a company lock can only raise the mode. A model is used only after it passed the driving test, and `on` runs only on a model that passed the replay check and two weeks of shadow; until then a project set to `on` runs in shadow. 0 plans, runs and shows no second review. Deploy the worker image that runs it first, then the broker, then set 1; to roll back, set 0. Named environments only |
| `setupRecipes.enabled` | stack parameter SetupRecipesEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 offers a project's setup run the approved company setup recipes (written or approved by a company admin) that are offered to the project and fit its repository. A recipe is only a proposal source: the run reads the project's default branch, adds the recipe's commands and checks to what its detectors found, cites each value as the recipe's, leaves out any command that downloads and runs code, and the result is still proved in a fresh sandbox and confirmed by a person. A recipe never changes the tier, the nightly run or what a project may reach. 0 offers no recipe. Deploy the worker image that reads recipe offers first, then the broker, then set 1; to roll back, set 0. Named environments only |
| `nightlyHealth.enabled` | stack parameter NightlyHealthEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets the nightly run set the project's health: a night whose setup (not its tests) failed shows "Setup needs repair" with a Fix setup card, and new tasks still start but show a "testing may be blocked" banner. It needs the test environment (`testEnvironment.enabled`). 0 records and shows no health |
| `insights.enabled` | stack parameter InsightsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 turns on the Insights reads (`/v1/app/insights`: stuck work, shipped outcomes, spend and flow) and the viewer grant (`/v1/app/org/insights-access`), so a company owner or admin can see them and grant others the viewer role. The Insights screen itself is always there (decision 125; it is no longer a screen flag); while this is 0 the Insights page says it isn't turned on yet and the navigation shows no Insights entry. 0 answers every Insights path except the overview as an unknown path, and the overview says `enabled: false`. Named environments only |
| `verifyResults.enabled` | stack parameter VerifyResultsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 makes a task and its pull request say one of four test results (Verified, Code failed, Partially verified, Blocked by environment) with a Testing section that lists every check and its result, and opens a Fix setup card for the project's maintainers when the test environment, not the code, kept the checks from giving a verdict. Only "Code failed" sends work back to coding. Deploy the broker first, then set 1 (turn on after a replay of recent tasks shows no code failure labelled as environment); to roll back, set 0. Named environments only |
| `setupAgent.enabled` | stack parameter SetupAgentEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets Set up this project start a live setup run: an agent that runs commands in a sandbox to get the project's checks working, with a host-ask card for each new website it needs (the maintainers approve or refuse each; the run never gets connector tools). 0 keeps setup as the read-only draft, the prove run and the confirm card. Turn on only after the five Linux checks of SH-1 pass and the worker image that carries `task.setupAgent.v1` is deployed first, then the broker, then set 1; to roll back, set 0. Named environments only |
| `testServices.enabled` | stack parameter TestServicesEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 gives a project's test dependencies (databases, caches, queues, AWS services, outside APIs) a backing on a sealed per-run network. Turn on only after the Linux checks TS-L1 to TS-L6 pass (`scripts/linux-check-test-services.sh`) and the worker image that carries the service runner is deployed; 0 keeps today's flow, where a project with services is refused as before. Named environments only |
| `testAccounts.enabled` | stack parameter TestAccountsEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets a project use the customer's own test account for a dependency, each approved by a second admin (needs `testServices.enabled`); 0 stores, approves and uses none. Named environments only |
| `projectImages.enabled` | stack parameter ProjectImagesEnabled on agentx-<env>-control-plane | 0 | 0 or 1; 1 lets a project bring its own images for a dependency (reviewed compose services, a model image; needs `testServices.enabled`); 0 uses only Rovara's image catalog. Named environments only |
| `workflowDependencies.enabled` | stack parameter WorkflowDependenciesEnabled on agentx-<env>-control-plane | false | true or false; true lets a task break its work into serial parts inside the one task (the plan's breakdown is approved, run in order, and a failed part is retried); false runs tasks as one piece. Named environments only |
| `taskPeople.changesEnabled` | stack parameter TaskPeopleChangesEnabled on agentx-<env>-control-plane | false | true or false; true lets a task's owner manage who is on a task (owner, commenter, viewer, denied) and lets a person take over an ownerless task. A task person is a current member who may write (not an Auditor), however they sign in (web, GitHub, an identity provider or Slack); a Slack account or channel alone is not a membership. People lists exist for tasks shared into Slack. Turning it on also creates the task person proof function the dispatcher's person check needs, in this environment (new resources only). Named environments only |
| `taskPeople.publicInvitations` | stack parameter TaskPeoplePublicInvitationsEnabled on agentx-<env>-control-plane | false | only false for now: automatic Slack invitations are not built yet (they need a Slack reinstall with new scopes) |
| `taskPeople.privateInvitations` | stack parameter TaskPeoplePrivateInvitationsEnabled on agentx-<env>-control-plane | false | only false for now, as above |
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

## New companies by invitation only (Rovara Cloud)

On the hosted Rovara Cloud, nobody can make a company by signing in. A cloud (email code, Google) or GitHub sign-in with no company and no usable invite is refused with "Rovara is invitation-only right now. Ask someone at your company to invite you." Nothing is created: no company, no member, no budget rows. An invite still works, a person who already has a company still signs in, and Slack, company and SAML sign-in are unchanged. A Rovara Code or self-hosted install has no such setting and behaves as before.

- **The setting:** stack parameter `NewCompaniesByInvitationOnly` on `agentx-<env>-control-plane`, default `1`, allowed `0` or `1`. It exists only where the cloud identity does (the `agentxCloud` context). Set it to `0` to let anyone who signs in start a trial company again. The sign-in function reads it as `DEVELOPER_NEW_COMPANIES_INVITE_ONLY`.
- **The user pool:** the same parameter sets the cloud user pool's `AdminCreateUserConfig.AllowAdminCreateUserOnly` (`1`: true, so nobody can sign up by themselves; `0`: false). It is an in-place update with no interruption; the pool is never replaced.
- **How an invitee gets in with sign-up off:** opening an invite makes the invitee's pool user with `AdminCreateUser` (email verified, no email sent by Cognito), then the person signs in with the emailed code. An email invite uses the address it is written for. A link invite asks for an email address on its page (a POST form, so the address is in no URL). `agentx login --invite` does the same for an email invite; for a link invite it tells a new person to open the link in a browser. Pool users made from a link invite are capped at 3 per invite per day and 10 per source address per hour (the sign-in table's `DECIDE_RATE#` items), and the log names the invite by a hash prefix and a count, never the address. The sign-in function already holds `cognito-idp:AdminCreateUser` and `AdminGetUser` on this one pool.
- **If the pool is not wired:** with the setting on but no `DEVELOPER_CLOUD_USER_POOL_ID`, the sign-in function still refuses to make companies and logs `signin.invite_only_without_pool` once at start, because invitees with no pool user cannot be given a sign-in.
- **A deploy that predates this setting:** a stack that never had the parameter gets `1` on its next update, so the safety setting cannot be left open by omission.

## A custom domain for the control plane (Rovara Cloud)

Optional, for a Rovara Cloud install deployed with the cdk engine. It puts the control plane (the web app at `/app`, sign-in at `/v1/auth`) at a name you own, for example `https://staging.rovara.dev`, in front of the same HTTP API. Off by default: with nothing set, no resource is added and no address changes.

What it adds, and only this: a regional certificate for the name (validated by a DNS record that CloudFormation writes in your hosted zone), an API Gateway domain name with one mapping to the API's `$default` stage, and alias `A` and `AAAA` records for the name. It never reads or changes any other record in the zone, so a zone that also serves a website at its apex (rovara.dev serves GitHub Pages there) is not touched. The hosted zone must be in the same AWS account as the install.

### Set it

```sh
agentx --env <env> signin cloud --custom-domain staging.rovara.dev --hosted-zone-id Z0123456789ABCDEFGHIJ
agentx --env <env> upgrade --region <region>
```

The first command only records the two values, in a record of their own (`/agentx/<env>/custom-domain`), not in the environment settings or the install answers, so a 0.5.6 `agentx` can still read the environment if you ever roll back (`--no-custom-domain` deletes the record). Nothing in AWS changes until the upgrade. The upgrade applies them, access stack first: the deploy role (the CloudFormation service role in the access stack) gains grants for this name and this one zone, and nothing else, and then the control plane gets the certificate, domain name, mapping and records. Certificate validation usually takes a few minutes; the control plane stack waits for it. The upgrade then records the new address as the environment's `controlPlaneUrl` (machine callers keep using the API's own address, which the stack still reports as `ApiEndpoint`).

The deploy role's new grants exist only while a name and a zone are set (statement ids `CustomDomain*` in the access stack, which takes the same two parameters):
- `acm:RequestCertificate` on `*`, only in the install's region, only for exactly that domain name (a request that names no domain is refused), and only when the request tags the certificate `agentx:env=<env>`;
- `acm:AddTagsToCertificate` only when the request sets that tag and the certificate already has it; `acm:DescribeCertificate`, `DeleteCertificate`, `RemoveTagsFromCertificate` and `ListTagsForCertificate` only on certificates that carry that tag. So the role can touch no other certificate in the account: it cannot tag a certificate that is not its own and then delete it. (CloudFormation tags the certificate when it creates it. If stack-level tags are ever added to the control-plane stack, they must include `agentx:env=<env>`, or the next update of the certificate is refused.)
- `route53:ChangeResourceRecordSets` on that one hosted zone, only for the names `<name>` and `_<hash>.<name>` (the DNS validation record) and only record types A, AAAA and CNAME, so the zone's apex and every other record are out of reach;
- `route53:GetHostedZone` and `ListResourceRecordSets` on that zone, `route53:ListHostedZones` (it takes no resource), and `route53:GetChange` on `change/*` (a change id cannot be known in advance).

API Gateway domain names and mappings are already covered by the role's `apigateway:*`. The condition keys and the tag conditions have not been run against AWS yet: if the first upgrade is refused, the error names the action, and the fix is to loosen that one statement and report it.

The upgrade order protects the resources: adding a domain deploys the access stack first (the grants exist before anything needs them); removing it deploys the control plane first (it deletes the certificate, the records and the validation record while the grants are still there) and the access stack last. Changing to another name in one step is refused: remove the old one, upgrade, then add the new one. Removing the domain together with a version change is refused too (the new release's templates would run under the old release's grants): remove it with an upgrade to the version the environment already runs, then upgrade to the new release.

### Register the new address with the sign-in apps (by hand, before people use it)

The sign-in redirect addresses are built from the name, so each provider that lists them must list the new one. The old addresses can stay listed, so sign-in through the API's own address keeps working while you move.

1. **Slack, "Sign in with Slack"**: at api.slack.com/apps, open the install's Slack app, OAuth & Permissions, Redirect URLs, add `https://<name>/v1/auth/callback/slack`, save. `agentx --env <env> signin check` then tests it ("Slack redirect URL").
2. **GitHub sign-in (OAuth app)**: GitHub allows one callback URL per OAuth app. Set it to the stack output `CloudIdentityGitHubCallbackUrl` (`https://<name>/v1/auth/callback/github`). From then on, signing in with GitHub through the API's own address is refused by GitHub; the other methods are unaffected. `agentx signin cloud` prints this URL when GitHub sign-in is on.
3. **Google**: nothing. Google redirects to the Cognito hosted domain, which does not move. The Cognito app client's callback list is updated by the upgrade and keeps both addresses.
4. Company sign-in with OpenID Connect or SAML, if the install uses it: add `https://<name>/v1/auth/callback/oidc` (OpenID Connect), or for SAML the assertion consumer URL `https://<name>/v1/auth/callback/saml` and the metadata URL `https://<name>/v1/auth/saml/metadata`, at the identity provider.

Not moved on purpose: the Slack app's event and interactivity URLs, the GitHub App's webhook URL, the event-hook URLs (`/v1/hooks/...`, which vendors register once and which must still resolve if the domain is removed), and every address the workers and services call. These are machine calls that keep using the API's own address (workers and services reach it through the VPC endpoint and the egress allow-list, which a public name would not pass). Invite links still point at `ROVARA_WEB_ORIGIN` (default `https://rovara.dev/join`), which forwards by `web/rovara-dev-join/cell.json`; changing `cellUrl` there is a separate change to the public site, made after the checks below pass.

### Check it after the upgrade

1. `agentx --env <env> env use` (refreshes this computer's record), then `agentx --env <env> signin check`: the control plane offers exactly the enabled methods under the new issuer, and Slack lists the redirect URL.
2. `curl -s https://<name>/v1/auth/.well-known/agentx-configuration`: `issuer` and the endpoints are on `https://<name>`. The same call on the API's own address answers with its own address as the issuer.
3. Open `https://<name>/app` in a private window and sign in with each method that is on. Open a task link from Slack: it is on the new name.
4. `agentx login https://<name>` works, and so does `agentx login <the API's own address>` (the sign-in then runs as that address).
5. A page opened on the API's own address redirects to the same path on the new name: the web app (`/app`, `/s/...`), a task review page (`/review/...`), an approval confirmation (`/v1/app/approve/...`), the audit view, and the GitHub App's install callback (`/v1/github/install/callback`, so a connect started from an old link finishes on the domain). Only GET moves; nothing else on the API's own address is redirected. Slack event delivery and GitHub webhook deliveries still arrive (no change to check them: their addresses did not move).
6. Browser sessions are per host (`__Host-` cookies): everyone signs in once on the new name. While a domain is set, the API's own address stays an accepted issuer: a person who signs in or logs in through it gets tokens it signs as itself, and the broker accepts them as long as the domain is set (a token lasts one hour, but new ones keep being issued at that address). Taking the domain off ends that: tokens signed for the domain stop being accepted at the next deploy. A refresh token is exchanged at whichever address the command line signed in to.

`agentx --env <env> doctor` reports the GitHub webhook against the API's own address, as before.

### Staging proof runbook (enable, verify, remove, verify, re-enable)

Run once on staging after 0.5.7 is installed there, with a throwaway name if the real one should not be touched (a name under a zone you own, for example `cdtest.rovara.dev`). Each AWS read below is read-only; use the guarded staging wrapper for them (region us-west-2, account 944937319445). `<zone>` is the hosted zone id, `<name>` the domain, `<stack>` is `agentx-staging-control-plane`.

1. **Enable.**
   `agentx --env staging signin cloud --custom-domain <name> --hosted-zone-id <zone> --yes`, then `agentx --env staging upgrade --region us-west-2 --to 0.5.7` (the version staging already runs). Expect the access stack first, then the control plane, which waits a few minutes for the certificate.
2. **Verify it is there.**
   - `aws cloudformation describe-stacks --stack-name <stack> --query "Stacks[0].Outputs[?OutputKey=='PublicUrl'].OutputValue"` prints `https://<name>`.
   - `aws acm list-certificates --region us-west-2` lists `<name>` as ISSUED; `aws acm list-tags-for-certificate --certificate-arn <arn>` shows `agentx:env=staging`.
   - `aws route53 list-resource-record-sets --hosted-zone-id <zone> --query "ResourceRecordSets[?contains(Name, '<name>')]"` shows the A and AAAA aliases and the `_<hash>.<name>.` CNAME, and the zone's other records are as before.
   - `aws apigatewayv2 get-domain-names --region us-west-2` lists `<name>`; `aws apigatewayv2 get-api-mappings --domain-name <name> --region us-west-2` shows one mapping to the API's `$default` stage.
   - `curl -s https://<name>/v1/auth/.well-known/agentx-configuration` answers with `issuer` on `https://<name>`; the same call on the API's own address answers with its own issuer. Then the checks in "Check it after the upgrade".
3. **Remove.**
   `agentx --env staging signin cloud --no-custom-domain --yes`, then `agentx --env staging upgrade --region us-west-2 --to 0.5.7` again, at the same version. Expect the control plane first, then the access stack.
4. **Verify nothing is left.** Each of these returns nothing for `<name>`:
   - `aws acm list-certificates --region us-west-2 --query "CertificateSummaryList[?DomainName=='<name>']"`
   - `aws route53 list-resource-record-sets --hosted-zone-id <zone> --query "ResourceRecordSets[?contains(Name, '<name>')]"` (no alias A or AAAA record and no `_<hash>.<name>.` validation CNAME)
   - `aws apigatewayv2 get-domain-names --region us-west-2 --query "Items[?DomainName=='<name>']"`
   - `aws iam get-role-policy --role-name agentx-staging-cloudformation --policy-name deploy --query "PolicyDocument.Statement[?starts_with(Sid, 'CustomDomain')]"` is empty.
   - `PublicUrl` is the API's own address again, and `aws cloudformation describe-stack-events --stack-name <stack>` shows no `DELETE_FAILED`.
   If a certificate or a record is left, the delete was refused: look for `AccessDenied` in the stack events (below), and delete the leftover by hand only after reading what it is (a leftover alias record makes the next enable fail with "record already exists").
5. **Re-enable.** Repeat step 1 and the first three checks of step 2. It must succeed with no manual clean-up.

**If `AccessDenied` names an action.** Read it from `aws cloudformation describe-stack-events --stack-name <stack-or-access-stack> --query "StackEvents[?contains(ResourceStatusReason, 'AccessDenied') || contains(ResourceStatusReason, 'not authorized')].[LogicalResourceId,ResourceStatusReason]"`. It names the action and the resource. Add exactly that action to the matching `CustomDomain*` statement in `packages/contracts/src/access-policies.ts` (keeping its resource and conditions), run `agentx upgrade` (the access stack deploys first), and retry. Two cases are expected to need a decision, not just an action: (a) the first enable is refused on `acm:RequestCertificate` or `acm:AddTagsToCertificate` because the certificate handler does not tag as assumed; (b) the remove leaves the certificate because the handler calls `RemoveTagsFromCertificate` before `DeleteCertificate`. Report either one rather than widening the tag condition. A failed enable rolls the control plane back; check step 4 before trying again.

### Roll back

The API's own address never stops working, so there is no outage to undo. To take the name off:

1. `agentx --env <env> signin cloud --no-custom-domain`, then `agentx --env <env> upgrade --region <region>`. The upgrade sends empty values for the two parameters, deploys the control plane first (it deletes the certificate, the domain name, the mapping, the alias records and the validation record, using the grants still in place) and the access stack last (it drops the grants). The zone's other records are not touched. The recorded address returns to the API's own.
2. Put the Slack and GitHub OAuth redirect addresses back to the API's own (the Slack list may keep both; GitHub holds one). People signed in on the name sign in again; tokens signed for the name stop being accepted at the next deploy.
3. To use a different name, do step 1, then set the new one (`signin cloud --custom-domain ... --hosted-zone-id ...` and `upgrade`). Changing in one step is refused.
4. Remove the domain at the version the environment runs now, not in the same upgrade as a new release.
5. Do all of this before downgrading to a release older than 0.5.7: its templates do not declare the two parameters, and CloudFormation refuses a parameter its template lacks. An emergency 0.5.6 `agentx` still reads the environment (the domain is not in the settings, and `controlPlaneUrl` is just a URL), but its deploy would send no domain parameters and fail on the 0.5.7 stacks, so remove the domain first.

An upgrade with operator credentials is not possible on a Rovara Cloud install (it is deployed with the cdk engine, which the operator role cannot use), so the access stack is never skipped on these upgrades.

## Operator backfill scripts

Two one-off scripts in this repository fix data written before a release. Both run from a checkout of the release's tag (`npm ci`, then `npx tsc -b packages/contracts`, then `npx tsx scripts/<name>.ts`), print counts and never a name, and can be run again.

**Who can run them.** They read and write the State and audit tables directly, so they need an install admin's AWS credentials (for the first script: `dynamodb:Scan` on the audit keys table, `dynamodb:BatchGetItem`, `GetItem`, `PutItem` and `UpdateItem` on the State table, and `lambda:InvokeFunction` on the sign-in function). The operator role (`agentx-<env>-operator`) is denied all of these on purpose and cannot run them. Neither script needs `--profile`: set the credentials and `AWS_REGION` in the environment (or pass `--region`), the way a release wrapper does. `--profile` is only for a run outside a wrapper.

### Erase the chosen names of people erased before 0.5.11 (required, 0.5.11)

`scripts/backfill-erased-names.ts`. Required once per install after upgrading to 0.5.11 and before people are told they can pick a new name after an erase. Without it, a person erased before 0.5.11 who signs in again gets the name they chose back into their own "me" name and into invite and SSO emails.

It finds everyone erased from the audit ledger (the `SUBJECT#<developer id>` tombstones in the audit keys table, the only record that still holds the id), then runs the broker's own `nameEraserOf(...).erase` for each: the name item in the State table becomes a tombstone with no name, and the sign-in function clears the name on the sign-in record. It does not touch anyone whose name item is already a tombstone with no name, except to repeat the sign-in function's erase for them (it sets the same placeholder again; nothing changes the second time), because an earlier erase may have stopped between the two steps. It keeps the new name of anyone who was erased and then chose a new name for a new membership.

Dry run first (the default; writes nothing, lists counts and short hashes of ids):

```sh
npx tsx scripts/backfill-erased-names.ts \
  --keys-table <audit keys table> --state-table <state table> --identity-function <sign-in function name>
```

Then write:

```sh
npx tsx scripts/backfill-erased-names.ts \
  --keys-table <audit keys table> --state-table <state table> --identity-function <sign-in function name> --apply
```

The table names and function name can be set as `AUDIT_KEYS_TABLE_NAME`, `STATE_TABLE_NAME` and `DEVELOPER_IDENTITY_FUNCTION_NAME` instead (the names the broker uses; see the stack outputs and the broker's environment). `--no-sign-in` is for an install with no sign-in function.

- The summary is one JSON line on stdout (the broker's own log lines go to stderr) and a sentence on stderr: `people`, `alreadyErased`, `signInConfirmed`, `rejoinedKept`, `toErase`, `erased`, `failed`, `failureCodes`, `shreddedOrgs`. A second `--apply` prints "Nothing to change".
- Exit codes: 0 only when every page was read and nothing failed; 1 if any erase or read failed (the counts printed are what was done before it; run it again); 2 for a bad option; 3 when it stopped at `--max-pages` or `--max-ms` before the end. The step is not done until a run exits 0.
- It is bounded: `--page-size` (default 100), `--max-pages`, `--max-ms` (default 10 minutes) and `--pause-ms` (default 200). A throttled call is retried with a pause. After exit 3 run it again with the same `--cursor-file <path>` to continue (counts are per invocation). The cursor file holds developer and company ids: keep it in a private directory, it is written with mode 0600 and removed when the run finishes; delete it yourself after a failed run once the step is done. A page with a failure ends the run (exit 1) with the cursor left at that page, so running it again with the same cursor file retries it; never delete the cursor file to "skip" a failure. A dry-run cursor is refused by an `--apply` run.
- Known gaps. (1) A company that was closed and shredded has no ledger tombstones left, so people erased only there cannot be found; the summary counts `shreddedOrgs` and the operator checks them by hand. (2) Someone erased before 0.5.11 who has already chosen a new name before this runs is erased again and must choose again, which is why it runs first. (3) With the team record on, the product keeps keyed hashes of an erased person's names for 30 days so the old name cannot be chosen again at once; this backfill keeps none, so a person erased in the last 30 days may type their old name again.

### Index old merge commits (optional, 0.5.9 and later)

`scripts/backfill-merge-commit-index.ts` indexes the merge commits of pull requests merged before the index existed, so a revert of one of them is recorded. Optional and only for merges whose outcome samples still exist; it reads with a consistent `Scan` and puts missing rows with `attribute_not_exists`.

```sh
npx tsx scripts/backfill-merge-commit-index.ts --table <state table>
```

`--region` (or `AWS_REGION`) is required; `--profile` is optional. A run stopped by `--max-ms` prints the key to resume from (`--resume '<json>'`).

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
