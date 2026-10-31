# Rovara Enterprise edition: operating pack (draft)

Draft of 30 October 2026, for owner review. For the engineering and security leads of a company that runs Rovara in its own AWS account under a managed-VPC agreement. It is the Enterprise variant of the Cloud pilot operating pack, and it follows its structure. It is generic: it names no customer, and a company's code host, build system, tracker and sign-in are plug-ins.

How to read it: "Today" means true now. "Proposed" means designed and not built. "Owner to decide" means we have not decided and will not promise it until we have. "Not yet tested" means exactly that. We make no commitment on times or service levels beyond what is written here. The security pack (`security-pack-draft.md`) carries the evidence marks for every claim made here.

## 1. Where it runs, and who does what

- **Place.** One company per install, in your AWS account and region, deployed from a signed release bundle (proposed; not built) by `rovara init` and `deploy` with the `enterprise` profile. Rovara Cloud is not involved: the install is its own centre, and it is designed to send nothing to Rovara by default. Today the profile exists as infrastructure code and tests; it has not yet run in a customer-shaped account (the install proof does that). Two things stand between today and "nothing leaves": the broker's own functions do not yet run inside your VPC, and there is no private path from workers to the control plane (security pack, section 2).
- **Your code and data.** Code sits in encrypted workspace volumes in your account, under your KMS keys. Models run on your Bedrock through a private endpoint. People sign in with your identity provider.
- **Managed-VPC agreement.** Rovara operates the install: we run upgrades, watch its health and apply software fixes. You own the account, the network, the identity provider, the keys and the backups. The split is in section 11 of the security pack.
- **Operator access.** We use one standing operator role in your account that you approve, can suspend at any moment, and can audit. It can start a deployment only of a signed bundle whose hash you approved, through a deploy role that you own; it is denied IAM changes, shell access to workers and reads of your stores; each session names the person using it. The proposal, and what it does not promise, is in appendix A of the security pack. It is built as infrastructure code and tests and has not run in an account (task N6, rescoped from break-glass only; see `operator-role.md`). **Owner to decide:** change windows, and the final shape after your security team reviews it.
- **What we do not promise.** No claim of certification. No claim of isolation beyond what the security pack lists. Two sandbox gaps are open (agent shells reaching host listeners, and dev-container projects running with fewer restrictions); an install does not hold real code until the first is closed.

## 2. Backup and restore

The backups are yours; the runbook and the rehearsal are ours to supply. Today we have not tested a restore in an Enterprise-shaped install.

| Data | Today | Restore tested? |
| --- | --- | --- |
| Main records (companies, projects, tasks, approvals) | DynamoDB point-in-time recovery on, 35 days. Tables are kept if a stack is deleted. | No |
| Audit records | Point-in-time recovery on, deletion protection on, sealed copies in a locked, versioned bucket. Personal details sit under per-person keys that are deliberately not backed up. | No |
| Model proxy database (spend, stored company keys) | Automated backups for 7 days. Restoring needs a retained encryption secret. | No |
| Workspace disks | No scheduled snapshot found. A lost workspace is re-cloned from your code host; unpushed work would be lost. | No |
| Infrastructure | Defined as code, so an install can be rebuilt from a release bundle. | No |

Proposed restore drill, run with you in a test account with made-up data: create a known set of records and audit events, change some on purpose, restore the main and audit tables to new tables as of a noted time, compare counts and confirm the audit chain verifies, then write the steps to switch the running service to the restored tables and time each one. Delete one workspace disk and confirm the task recovers by re-cloning. Success: every record present after restore, the audit chain verifies, a runbook someone other than its author can follow, and a measured recovery time per store. **Owner to decide:** recovery targets and the drill date. Recommendation: run the drill before the first real project, set targets from what it measures, and only then put numbers in the agreement.

## 3. Support and incidents

Today: no support contact, response times, on-call rota or status page exist for the Enterprise edition.

- **Owner to decide:** named contacts and channels, one urgent and one normal. Recommendation: a shared channel plus a monitored mailbox, two named people on each side.
- **Owner to decide:** hours, first-response times and severity levels. Recommendation: write only what we can staff, and no figure we have not drilled.
- **Owner to decide:** how fast we tell you about an incident. Recommendation: a first notice before a full explanation, a written account afterwards, and the notice window written into the agreement.
- **Proposed:** `rovara support-bundle` builds a redacted diagnostic archive (versions, health, error codes, doctor output; no content, no names, no repository names) that your operator reads before sending (task N7). Not built.
- **Proposed:** "fix with agent" runs inside your install on your Bedrock, so first-line help never leaves the account.
- Alarms go to your alert topic. Whether it has a subscriber is yours to set; we will test that an alarm reaches the people you name.

## 4. Data terms

**What stays in your account:** task text, plans, comments and model conversations; copies of your repository files in workspaces; records of what each task did; people's names and emails for sign-in and roles; project settings; screenshots from browser tests (30 days); company AI keys if you supply any (encrypted); the audit ledger (ids and actions, personal details sealed per person). Nothing is copied to Rovara.

**What can leave, and only if you turn it on.**

- A model provider other than your Bedrock, if your admin adds one as a model source.
- Systems your admins connect: your code host, build system, tracker, chat, observability tools. Each needs an entry on the egress allow-list.
- The update check (proposed, opt-in, off by default): one HTTP GET for our signed release manifest, sending nothing beyond what your network shows. Not built.
- Telemetry (proposed, off by default, after the pilot, if ever): counters only, never content, names or repository names. You see the exact payload before turning it on. Not built.
- The list of every outbound host the code can name is `outbound.md`. It also lists the two defaults an Enterprise install must change (the public audit timestamp authorities, and the default DNS allow-list).

**Team record retention.** Enterprise default: raw text for about 30 days and distilled facts and lessons long-term, set per source by an admin. Slack text, if you connect your own Slack app, is off until a legal check of Slack's terms for internal apps is done. Proposed; not built.

**Personal AI accounts.** The only personal source is a member's own ChatGPT plan. It is off unless an install-wide switch is on; the Enterprise setting keeps it off.

**Deletion and offboarding.** A person leaves: an owner or admin removes them; access ends and their tasks stop at the next step. Closing a company is permanent: running work stops, links to connected systems are cut, stored keys and tokens are scheduled for deletion after seven days, sessions and chat history are deleted after 30 days. The audit log is kept (it is written to storage that cannot be changed before its retention date, 1,096 days on a production install); within 30 days of the close the keys that unlock personal details are deleted, so the log then shows ids and actions only. Today a scripted end-of-engagement deletion runs by hand from a written runbook, scoped to one company, and has to be rehearsed before first use. **Owner to decide:** the data processing agreement and privacy terms, which do not exist yet.

## 5. Upgrades and rollback

- **Who does it.** Rovara runs upgrades, in your agreed change window, by starting the deployment of a bundle you approved; your deploy role does the changes. Proposed. Today an upgrade is `rovara upgrade` run by whoever holds the install; the signed-bundle path (`--bundle`) is not built (tasks N2, N3).
- **Before each upgrade** you receive the release notes and the bundle's manifest hash, and you approve it. Proposed.
- **What the upgrade does.** Verifies the signature and every hash, runs pre-checks (doctor, schema compatibility), takes a restore point (a point-in-time timestamp plus the previous bundle id), then deploys in the existing fixed order. A changed byte is refused before anything changes. Proposed. The tool already refuses to install an older release, because newer data may not be readable by older software. A running workspace keeps its old software until it next starts.
- **Air-gapped installs** import the bundle through your own S3. Proposed.
- **Rollback is not rehearsed.** The plan is to redeploy the previous bundle and restore to the restore point, and it must be rehearsed with no data loss (task N10e) before we promise it. Until then we fix forward.
- **Owner to decide:** notice and window lengths. Recommendation: announce each upgrade in the shared channel, run it outside your working hours, and allow only fixes you have been told about during the first weeks.
- Your own "How we work" changes can be rolled back by a maintainer at any time.

## 6. Supported stacks and limits

- **Code host.** GitHub (github.com) is the first plug-in and the only one built. Other hosts (GitHub Enterprise, internal code hosts) are adapters written with your team, behind the same neutral interface. Not yet built.
- **Build and checks.** GitHub Actions and CodeBuild are built as check runners; a customer build system is an adapter. Running your build inside the sandbox depends on its toolchain and registry access (private registries are task N9, not built).
- **Tracker.** Linear start and close are built; your tracker is an adapter (task P9 onward).
- **Sign-in.** OpenID Connect today; SAML proposed (task I4).
- **Languages.** The agent environment is built around Node and TypeScript projects. Python is partly tested. Anything else is not yet tested. Workspace machines are arm64 with 2 CPUs and 8 GiB of memory.
- **Repo size, monorepos, concurrency.** Not yet tested; no load test; one repository per workspace. **Owner to decide:** the first project's size cap.
- **Branch.** Rovara works from, and opens change requests against, the default branch.
- **Time estimates** shown with a plan include time spent waiting for a person.

## 7. What we are fixing before the first real project

1. Close the agent-shell host-listener gap (TF16) and the dev-container gap (TF13, TF19), or refuse dev-container projects.
2. Build the signed bundle and upgrade, with the model proxy image in the bundle (N2, N3).
3. Rescope and build the operator role as in appendix A of the security pack (N6), then rehearse suspending it.
4. Refuse the default public timestamp authorities for the Enterprise edition; build the DNS allow-list from your settings (E2, N8, N9).
5. Wire group mapping into sign-in; build SAML if needed and the Auditor role (I1 wiring, I4, I2).
6. Prove the sealed network in a test account with an allowed call, a blocked call and flow logs (N10a to N10c).
7. Run the leak check, the restore drill, the rollback rehearsal and the deletion rehearsal.
8. Name support contacts and test that an alarm reaches them.

During:

- A run limit on memory per task.
- A failed setup can show as "running" for several minutes before it is marked failed.
- Removing a member: choosing who takes over, and retrying sign-out until it works.
