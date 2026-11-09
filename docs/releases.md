# Rovara releases

A release is a tagged, versioned bundle: the CloudFormation templates the installer deploys, the
code packages those templates reference, two container images, and the Rovara Code CLI on npm
(`@preplabsai/rovara-code`, command `rovara`, compatibility alias `agentx`). All of
it is built from the same tagged commit, so a release is always self-consistent.

## What a release contains

A release directory looks like this:

- `release.json`: the manifest: version, git commit, and a checksum for every file below.
- `legal/LICENSE` and `legal/RELICENSED.md`: the Apache 2.0 terms and the immediate grant for
  earlier versions, both listed and checksummed in `release.json`.
- `templates/<region>/<part>.template.json`: one CloudFormation template per stack part
  (`access`, `foundation`, `identity`, `runtime`, `control-plane`, `slack`), for each region the
  release covers. The covered regions are exactly the ones with verified EC2 worker
  availability-zone IDs (`SUPPORTED_REGIONS` in `infra/lib/production-foundation.ts`; today just
  `us-east-1`). Adding a region means adding its verified zone IDs there; nothing else changes.
- `packages/<assetId>.zip`: the Lambda code each template references, one zip per package, named
  by the hash of its contents so the same code always produces the same file. Code packages are
  shared across every region a release covers, because asset hashes don't depend on region.
- Two container images (the worker and the Slack listener), pushed to ECR Public and referenced
  only by digest (a fixed fingerprint), never by a tag that could later point at something else.
  They are built for `arm64` machines only, the same chip the installer's runtime uses.
- The worker image carries Node 22, Git, the Docker CLI and Compose, Python 3 with pip and venv,
  and uv. A change to `environments/base/Dockerfile` reaches installs only through a new release's
  worker image: tag a release, and upgrade each environment with `agentx upgrade`. Bookworm's
  system Python is externally managed (PEP 668), so a repository should use `python3 -m venv` or
  uv, not a bare `pip install`. `uv python install` needs network access.
- The CLI, published to npm as a single self-contained package with no separate dependencies to
  install.

## How templates render for your environment

The published templates are not built once per customer environment. They are synthesized a
single time for a reserved, made-up environment name that no real environment is allowed to have
(`qqenv-placeholderqq`). At install time, the CLI replaces every occurrence of that placeholder
(including the underscore-only form some AWS resource names require) with your real environment
name, and refuses to proceed if any trace of the placeholder is still left afterward.

This keeps one code path for naming instead of two (a template-time one and a CloudFormation-time
one), and it lets a release check prove the rendered template is byte-for-byte what synthesizing
directly for that environment name would have produced (FR-012).

## Cutting a release

1. Tag a commit on mainline `vX.Y.Z` (for example `v1.2.3`) and push the tag. Only repository
   admins can push `v*` tags (the `release-tags` ruleset). A tag on a commit that is not on
   mainline stops the workflow before it publishes anything.
2. That triggers the `Release` GitHub Actions workflow (`.github/workflows/release.yml`). It always
   runs the test job first: typecheck, the stricter type check (`typecheck:all`), lint, build, the
   full test suite, and `infra:synth`.
3. Nothing else happens unless the repository variable `AGENTX_PUBLISH_ENABLED` is exactly `true`.
   It is `true` since v0.1.0; see "Release setup" below.
4. When publishing is enabled, more jobs run in order:
   - **images**: builds and pushes the two container images, then reads back the digest the
     registry itself reports (not just what the build produced) before trusting it.
   - **release**: builds the release directory, verifies it, and creates a GitHub release titled
     "Rovara X.Y.Z" with `release.json` and a tarball of the whole directory attached.
   - **npm**: packs and publishes the CLI through npm trusted publishing, which adds provenance.
     A version already on the registry is skipped, not failed.
   - **installer**: builds the Launch in AWS button's installer (`npm run release:installer`) and
     uploads it to the installer bucket: `<version>/installer.template.json` and
     `<version>/packages/<assetId>.zip` first, then `latest/installer.template.json`, which the
     README's button opens. It runs only when `AGENTX_INSTALLER_BUCKET` is set, and after npm, so
     the template's pinned CLI version is always published.
5. The version always comes from the tag name. There is no way to type a different version by
   hand, even when re-running the workflow manually. A manual run must still be started from a
   tag, or it fails immediately with a clear error.

## Checking a release on your own machine

- `npm run release:build -- --version <version> --out <dir> [--worker-image <repo@sha256:...>] [--slack-image <repo@sha256:...>]`
  builds the same release directory the workflow builds (the image flags are optional; leave them
  out to build templates and packages only).
- `npm run release:verify -- <dir>` checks every file's checksum against `release.json`, then
  rebuilds the templates and packages from the current checkout and compares them again, to catch
  a release directory that no longer matches what today's source would produce.
- `npm run release:pack-cli -- --version <version> --out <dir> [--name <package-name>]` builds the
  npm package for the CLI and packs it into a tarball, without publishing anything.
- `npm run release:installer -- --version <version> --bucket <installer bucket> --out <dir>` builds
  the installer's quick-create template and code package as the workflow uploads them, and prints
  the Launch in AWS address. `aws cloudformation validate-template --template-body file://<dir>/latest/installer.template.json`
  checks the template without creating anything.

## Release setup

The first release, v0.1.0, shipped on 2026-10-06 from commit `87d28a2d`. Everything below is in
place; this records what it is, so a change to any piece can be made deliberately.

- **ECR Public repositories.** `agentx-worker` and `agentx-slack` in account `944937319445`
  (`us-east-1`), under the registry alias `i7z2k3a8`. A shorter alias, `agentx`, is requested and
  waiting on AWS's approval; switching to it means changing `AGENTX_ECR_PUBLIC_ALIAS`.
- **The publish role.** `arn:aws:iam::944937319445:role/agentx-github-release` can push images
  only to those two repositories, plus the two sign-in permissions ECR Public requires
  (`ecr-public:GetAuthorizationToken` and `sts:GetServiceBearerToken`). Its trust policy accepts
  GitHub's OIDC token only for this repository's version tags, matched by immutable ID rather than
  name:

  ```text
  token.actions.githubusercontent.com:aud = sts.amazonaws.com
  token.actions.githubusercontent.com:sub like repo:*@272978771/*@1307121896:ref:refs/tags/v*
  ```

  `272978771` is the PrepLabsAI organization and `1307121896` this repository. GitHub uses
  immutable subjects for this repository (`gh api repos/PrepLabsAI/Rovara/actions/oidc/customization/sub`),
  so a rename does not break the role; a transfer to another organization would.
- **The browser executor repository (not yet created).** Releases from the web/API runtime on
  also push `agentx-executor` (the browser executor image, built from
  `environments/e2e-executor/Dockerfile`; the worker pulls it at boot as `EXECUTOR_IMAGE`) and record
  its digest in release.json. Before the first such release, an owner creates the ECR Public
  repository `agentx-executor` beside the other two and adds it to the publish role's push
  permissions; until then the `images` job fails at that image. `release-test.yml` does not push it
  yet: the release test installs without an executor image, which the runtime stack allows.
  The release workflow builds and publishes the executor only when the repository variable
  `AGENTX_PUBLISH_EXECUTOR_IMAGE` is `true` (default off), so tagged releases keep working until
  the owner has created the repository and extended the role; release.json then has no executor
  image, which the runtime stack allows. Set the variable once both exist.
  Once the variable is `true`, release.json has an `images.executor` entry, and `ReleaseManifestSchema`
  validates `images` strictly (unknown keys are refused). A CLI built before the executor existed
  rejects such a release, so upgrade the CLI before installing or updating from a release newer than
  the one that first publishes the executor. Strictness is deliberate: an image key a CLI does not
  know must not be skipped silently.
- **The self-hosted embedder repository (not yet created).** The Team record searches with the embedder image
  (`environments/embedder`; Qwen3-Embedding-0.6B and bge-small baked into a linux/arm64 Lambda image, every Python package
  installed by hash, no network at run time). Releases push it as `agentx-embedder` and record its digest as
  `images.embedder` in release.json; the CLI passes it to the control plane (`EmbedderImageUri`), through the account's image
  cache in a Public install and from the install's own `rovara-bundle/<env>/embedder` repository in an Enterprise one
  (the signed bundle carries the image; the access stack creates that repository only where the Team record is built, so the
  other templates are unchanged, and the operator role gets no new ECR right). Before the first such release an owner creates
  the ECR Public repository `agentx-embedder` and adds it to the publish role's push permissions. The release workflow builds
  and publishes it only when `AGENTX_PUBLISH_EMBEDDER_IMAGE` is `true` (default off): the image build runs the parity check
  against the original weights and the offline smoke test, and pushes only if they pass. Until the variable is set, a release
  carries no embedder image and `agentx upgrade` refuses to build or keep a Team record on it (there is no search without the
  embedder). A CLI older than the first release with `images.embedder` refuses that release (`images` is strict).
  **To check on the first run:** that Lambda accepts an image in a pull-through-cache repository (Public path), and that an
  image in a customer-key-encrypted ECR repository can be used by the function (Enterprise path); neither was tested.
- **The executor image is smoke-tested under its production sandbox before it is published.** The `images` job
  builds the executor for linux/arm64 into the runner's Docker (`--load`), runs `npx tsx scripts/executor-smoke.ts <tag>`,
  and only then pushes that same loaded image (`docker push`), so the published bytes are the smoke-tested bytes; a
  failing smoke test stops the job before anything is pushed. Before the build it installs and builds the repository
  and applies the CI-only `kernel.apparmor_restrict_unprivileged_userns=0` sysctl (Ubuntu 24.04 runners block
  unprivileged user namespaces for AppArmor-confined containers; production hosts on Amazon Linux 2023 do not).
  These steps run before the AWS credentials are configured and only when `AGENTX_PUBLISH_EXECUTOR_IMAGE` is `true`.
  The smoke command has one definition, `scripts/executor-smoke.ts`, shared by that job, the CI `linux-runtime` job and
  `scripts/test-deploy.ts` (through `smokeTestExecutor` in `scripts/release-common.ts`): the image runs with the
  executor container's sandbox and limit flags from `executorContainerArgs` in the verifier (the source the Docker
  host builds its executor command from: pinned seccomp profile, every capability dropped, no-new-privileges, tini,
  read-only root with a `/tmp` tmpfs, shared memory, 2 GiB, 1024 processes, 2 CPUs) plus no network. The profile
  (`packages/verifier/assets/executor-seccomp.json`) is verified against its digest in contracts. The script imports
  the verifier's built output, so run `npm run build` first. Chromium runs with its own sandbox and the check never
  skips it. On a local Docker VM whose kernel restricts unprivileged user namespaces (colima's Ubuntu 24.04 VM) the
  smoke test fails with a message that names the fix:
  `colima ssh -- sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` (temporary; it resets when the VM
  restarts). Never work around it with `--no-sandbox`. The Docker VM also needs at least 2 CPUs for `--cpus 2`.
- **The npm package.** `@preplabsai/rovara-code`, owned by the `preplabsai` npm organization
  (publishing needs an owner or developer role there; GitHub access does not grant it). Version
  0.1.0 was published by hand from the tag's commit, because npm trusted publishing can only be
  configured on a package that exists. Its Trusted Publisher is GitHub Actions, `PrepLabsAI` /
  `Rovara` / `release.yml`, and publishing requires two-factor authentication with tokens
  disallowed. Trusted publishing matches the repository by name, so a rename means updating it on
  npm and the `repository.url` that `scripts/release/pack-cli.ts` writes. See
  [npm-package.md](npm-package.md).
- **Repository variables** (Settings, Secrets and variables, Actions, Variables):
  `AGENTX_PUBLISH_ROLE_ARN` (the role above), `AGENTX_ECR_PUBLIC_ALIAS=i7z2k3a8`,
  `AGENTX_NPM_PACKAGE=@preplabsai/rovara-code` and `AGENTX_PUBLISH_ENABLED=true`. Setting the last
  one to anything else turns publishing off; a tag push then runs only the test job.
- **The `release-tags` ruleset.** Restricts creating, updating and deleting `refs/tags/v*` to the
  repository admin role. The workflow checks a tag's name and that its commit is on mainline, but
  GitHub runs the tagged commit's own copy of the workflow, so whoever can push a `v*` tag can
  publish. The ruleset is what limits that to admins.
- **The license.** New releases declare MIT in `LICENSE` and npm package metadata. `LICENSE-APACHE`
  and `RELICENSED.md` travel beside it to preserve and document the Apache 2.0 grant previously
  issued for PrepLabsAI-owned Rovara work. The v0.3.0 GitHub release remains an Apache 2.0 release;
  its tag and artifacts are not rewritten. Earlier versions can also be used under MIT under the
  new grant. Third-party components keep their own licenses.
- **The installer bucket** (one-time setup, before the first release with the Launch in AWS
  button). `rovara-installer-us-east-1` in account `944937319445`, `us-east-1`: anyone may read its
  objects (the quick-create template, and the setup page's code, which Lambda reads from the
  visitor's own account); only the publish role writes them. The README's button points at it, so
  the name is fixed. From an admin profile in that account:

  ```sh
  B=rovara-installer-us-east-1
  aws s3api create-bucket --bucket "$B" --region us-east-1
  # Only if the account's own Block Public Access blocks public bucket policies:
  #   aws s3control get-public-access-block --account-id 944937319445
  aws s3api put-public-access-block --bucket "$B" --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=false,RestrictPublicBuckets=false
  aws s3api put-bucket-policy --bucket "$B" --policy "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"PublicRead\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$B/*\"}]}"
  aws iam put-role-policy --role-name agentx-github-release --policy-name installer-bucket \
    --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"s3:PutObject\",\"Resource\":\"arn:aws:s3:::$B/*\"}]}"
  gh variable set AGENTX_INSTALLER_BUCKET --body "$B"
  ```

## If a release fails partway

- Use GitHub's "Re-run failed jobs" button on the workflow run, not a fresh tag push. It re-runs
  only the jobs that failed (and the jobs after them); jobs that already succeeded, such as the
  images job, are not run again, and their results are reused.
- If only the npm job failed, "Re-run failed jobs" simply retries the npm step. Nothing else runs
  again.
- The one case that needs cleanup: the release job itself failing after it created the GitHub
  release (`gh release create` is its last step, so this is rare). A re-run then reports that the
  release already exists. `gh release create` publishes a real release, not a draft. To redo that
  version, delete the release and its tag, then push the tag again, or cut a new patch version.

## The release test

The `Release test` workflow (`.github/workflows/release-test.yml`) installs, upgrades and removes
real environments in a throwaway AWS account, with both engines and the platform team path. It
runs by hand, before a release is tagged, and never touches the live deployment.

### One-time owner setup

1. **A throwaway AWS account** that holds nothing else. The Elastic IP limit is 5 per region, and
   each environment's two NAT gateways take 2, so an empty account fits two environments. The
   workflow still runs one environment at a time, as a margin: it installs one after another and
   removes each before the next starts.
2. **A role GitHub can assume** in that account, with admin rights there. Its trust policy allows
   this repository's `workflow_dispatch` runs through GitHub OIDC (no long-lived keys), and its
   maximum session is at least 3 hours, since an install and an upgrade can outlast the 1 hour
   default. The workflow also names it as each environment's operator principal, so it must be
   able to assume `agentx-<env>-operator`. Store its ARN in the repository variable
   `vars.AGENTX_RELEASE_TEST_ROLE_ARN`. `vars.AGENTX_RELEASE_TEST_REGION` is optional (default
   `us-east-1`).
3. **Two private ECR repositories** in that account and region: `agentx-release-test/worker` and
   `agentx-release-test/slack`. The workflow pushes the candidate's images there.
   Each repository needs a lifecycle policy that expires `rt-*` images a few days after they are
   pushed: every run pushes both images tagged `rt-<run id>`, and nothing else removes them.
4. **A test GitHub App**, installed on a test repository: `vars.RT_GITHUB_ACCOUNT`,
   `vars.RT_GITHUB_APP_ID`, `vars.RT_GITHUB_INSTALLATION_ID`, and its private key in
   `secrets.RT_GITHUB_PRIVATE_KEY`.
5. **A test Slack app**, installed in a test workspace: `vars.RT_SLACK_CLIENT_ID`, and
   `secrets.RT_SLACK_BOT_TOKEN`, `secrets.RT_SLACK_SIGNING_SECRET` and
   `secrets.RT_SLACK_CLIENT_SECRET`.
6. **Turn it on:** set `vars.AGENTX_ENABLE_RELEASE_TEST` to `true`. Until then the workflow does
   nothing.

### Running it

In GitHub, open Actions, then Release test, then Run workflow, on the commit you plan to tag. Give
two versions: `previous`, the published release to install first, and `candidate`, the version
this commit will become (newer than `previous`).

For each engine (templates, then cdk), it installs `previous` up to the `developer-signin` step
(`init --stop-after developer-signin`), runs `doctor`, upgrades to the candidate, runs `doctor`,
changes a setting under the operator role alone, and destroys the environment. Then it runs the
platform team path: `init --export`, `deploy-access.sh`, `init --resume --from-bundle` under the
operator role, `doctor`, and `destroy`. A last job destroys anything a failed run left behind.

### The manual release check

Some steps need a person, so do these by hand before tagging, in a throwaway account:

1. One full `agentx init`, all the way to a Slack reply in the thread (docs/install.md).
2. `agentx --env <env> alerts test`, and check the alarm arrives.
3. Remove that environment by hand, following docs/teardown.md's "By hand" section, and check
   nothing is left.
4. Once, SC-001: a person who has never seen Rovara installs it from docs/install.md, on a clean
   computer and a new AWS account, with no help, and gets a Slack reply. Record every place they
   get stuck, and fix it.

### Before a release: run cfn-lint on the synthesized templates (record on and off)

CloudFormation refuses a template whose enum spelling or property is wrong only at deploy time (early validation), and the CDK types and contract tests do not see it. cfn-lint ships the CloudFormation resource schemas offline. It needs Python, so it is not in CI: install it in a throwaway venv, never in the repo, and run it on the control-plane stacks synthesized with the Team record off and on, for Public cloud and Enterprise. It must report no E-coded finding.

```sh
python3 -m venv /tmp/cfn-lint-venv && /tmp/cfn-lint-venv/bin/pip install cfn-lint
CFN_LINT=/tmp/cfn-lint-venv/bin/cfn-lint npx tsx scripts/release/cfn-lint-templates.ts   # exit 0 = no errors
```

## Release notes

Changes a person using Rovara will notice, newest first. One line each; the full story is in the commit.

- **0.5.11: required release step, erase the chosen names of people erased before this release.** After upgrading, an operator runs `scripts/backfill-erased-names.ts` once (dry run first, then `--apply`; steps, flags and exit codes in [day-two.md](day-two.md#erase-the-chosen-names-of-people-erased-before-0511-required-0511)). Until it has run, a person erased before 0.5.11 who signs in again can get the name they chose back into their own "me" name and into invite and SSO emails. A person who was erased may choose a new name when they rejoin; their old history stays "A former member".
- **The plan is read, discussed and decided in one place on the task page.** With decision cards on, a document's card shows what is needed, what Rovara will do (3 to 5 lines, from the document itself), the risk level and why, the cost and time, and how many comments are open. "Read the full plan" (and the requirements and the design) opens the whole document inside the task page: a side panel on a computer, a full-screen sheet on a phone. There you comment on any line, reply, edit or delete your own comments, suggest an answer, ask Rovara (its answer shows in the thread) and Remember or Forget a comment; the card's Approve and Request changes sit at the bottom, with the same rules and sign-in as the card. The PR feedback review is a view on the task page too, and the PR feedback Slack card opens it. Old links to the plan review page and the PR feedback page forward to the task page with the document or the feedback view open; the "Comment on the plan" link is gone. With decision cards off, both old pages work exactly as before. This replaces the note below about comments staying on the review page. With decision cards on, the old pages take no writes at all (only a People change's confirmation); a write sent to them is answered with where to make it now. Deploy the web app and the broker together: an older web page reading the new broker loses a card's questions, optional checks and open comments until it is reloaded.
- **Every decision is made on the task page.** With decision cards on, the plan review page (`/review/<task>/task`) no longer decides anything: approving or sending back a requirements, design or coding plan (with its question answers, optional checks, included comments and a note), retrying the browser and API checks, Revise the plan and a held spec's choices are on the task page in Rovara (its cards and the "What happens next" section), with the same rules as before; the review page shows "Decide on the task" instead. People role changes, take-over, and Remember or Forget on a comment are also on the task page. Until the next release, comments, replies, suggestions and Ask stay on the review page, which still takes them; the task page links to it ("Comment on the plan"). The PR feedback page (`/review/<task>`) still takes its decisions. With decision cards off, the review page works exactly as before.
- **A seed command that is the repository's own seed script can be approved by one maintainer.** When Rovara's detectors find a seed command (`npm run seed`, `npx prisma db seed`, `npx knex seed:run`, `npx sequelize-cli db:seed:all`) and the broker finds it unchanged on GitHub's default branch, and every dependency is Rovara's own throwaway test software, the test environment is medium risk: one maintainer approves it, with no second person. The seed has the same access as your setup commands (in the working phase it can reach the internet). Rovara hashes the seed's entry files (all of package.json, the seed file, the knexfile and `seeds/`, or the sequelize config and `seeders/`) and checks them again before every run. A change to any of them, on a branch or after a merge, stops the seed until the test environment is checked and approved again. A seed command that was typed or changed by a person, proposed by the model, or has a package manager settings file (`.npmrc`, `.yarnrc`, `bunfig.toml`) beside it is still high risk and needs a second person. So is every migrate command: migrate commands are never locked. Deploy workers and the broker together: a plan with a locked seed goes only to a worker that checks it.
- **Test environment setup on one screen: deploy the web app and the broker together.** The setup page now has one "Check it works" and one Approve, and the second person confirms on a card on that same page. The web app and the broker must be upgraded together: an older web page reading the new broker's answer stops showing the test environment until it is reloaded, and a newer web page's "Check it works" is refused by an older broker. A seed FILE (SQL) now loads into the test database as a role with no superuser rights, and its content is bound to the approval: a seed file changed after approval is not loaded, and the run asks for a new approval.
- **0.5.9: decisions now live on cards.** Cards are on for new installs, and the upgrade to 0.5.9 turns them on for existing installs too, even one set to 0 (it says so: "Decision cards are now on (decisionCards.enabled=1). To turn them off again: agentx config set decisionCards.enabled 0"). This happens once: a later upgrade keeps whatever you set afterwards. With cards OFF, the medium and high-risk rules below do not apply: a high-risk plan can still be approved from Slack, an AI tool (MCP) or the plan review page without any new sign-in. That is why cards are turned on. With cards on, medium and high-risk plans are approved in the Rovara app. High-risk decisions need a recent sign-in with the email code (never GitHub), on the card on the task page: high-risk plans and requirements, high-risk designs, a high-risk design review Skip and a high-risk design review cost choice. Slack and AI tools show Open in Rovara for them. Tokens and Slack never approve a run-limit raise. An operator can turn cards off (decisionCards=0) as an emergency switch.
- **0.5.9: merge happens on its card.** Merge happens on its card on the task page. A high-risk merge asks for a recent sign-in with the email code (never GitHub) on that same card, then merges there; there is no separate confirmation page. An AI tool or the command line still gets a confirmation link and never merges by itself.
- **0.5.9: design review costs are estimated honestly, and the default cost limit is $15.** Estimates now come from a real review run and err on the high side, so they are about 2.5 to 4 times higher than before. The default design review cost limit per task goes from $10 to $15 to match. Projects that already saved their own limit keep it. Review spending still counts toward the task's run limit. A review whose estimate is above the limit still asks a person to raise it or pick a lower tier; spending never goes past the limit.
- **Design review reads each finding on its own: upgrade window and rollback.** A reviewer's block is no longer refused as a whole because a finding id is long or a citation names a subsection (§3.1); only the finding or citation that is wrong is left out, and a blocking finding that could not be read shows as an open blocker. The upgrade updates the worker image before the control plane, so for a few minutes a new worker can report a reviewer's answer that the previous control plane reads as not usable: that reviewer then counts as not run for that round. Press Retry review once the upgrade has finished, and start no design reviews during the upgrade. Rollback: a design review that recorded unreadable findings on a round (a new field on the stored round) cannot be read by the previous version, so do not roll back to it while such a review is open; close or finish it first.
- **0.5.8: upgrade window.** The upgrade updates the worker image before the control plane, so for a few minutes a newly started worker can report to the previous control plane. Only a design review round where some reviewers answer and another is refused as 'model not available' is affected: that round's answers are dropped and the review shows as not run; press Retry review once the upgrade has finished. To avoid it, start no tasks during the upgrade.
- **0.5.7: the hosted cloud can have its own web address.** Optional and off by default, for a Rovara Cloud install: `agentx --env <env> signin cloud --custom-domain staging.rovara.dev --hosted-zone-id <Route 53 zone id>` records a DNS name and the hosted zone (in the same AWS account) that holds it, and the next `agentx upgrade` adds a certificate, the name in front of the same API, and its DNS records. Then the web app, sign-in, task links and Slack links use that name. The API's own `execute-api` address keeps working: the same API answers on both, the command line and its sign-in still work against it, tokens signed under it are accepted while the domain is set, and a browser page opened on it moves to the new name. Installs that set nothing see no change. The steps, the sign-in apps to update by hand (Slack and the GitHub OAuth app; Google needs nothing), what to check afterwards and how to roll back are in [day-two.md](day-two.md#a-custom-domain-for-the-control-plane-rovara-cloud).
- **0.5.7: the old design review project list is gone.** The deploy setting `designReview.projects` (stack parameter DesignReviewProjects) and the one-time carry-over of its projects are removed. Whether a project gets a design review is decided only by the operator switch `designReview.enabled`, the company's "allowed" setting with its rules, and each project's How we work mode. `agentx upgrade` reports a deployed value as dropped (`config key DesignReviewProjects (...) is not in release 0.5.7, so the upgrade drops it; nothing replaces it`) and does not send it. If your install had dp set, allow design review in company How we work and set the project to Auto.
- **0.5.5: design review is now turned on in How we work.** First a company admin allows design review on the company's How we work page. Allowing it needs a second admin to confirm, or the company's only owner can do it alone. Then each project's maintainers turn it on (Auto or Always) on the project's How we work page, and can turn it off again. Projects start Off. Company admins can also set rules every project follows: a cost ceiling, no skipping, "Tier at least", and the group that approves high-risk designs. These rules never stop a project from turning design review off. The old deploy setting `designReview.projects` no longer controls anything and can no longer be set. On upgrade, projects listed there are carried over (on a single-company install, into that company; with several companies, only where a design review had already run for that project). A carried-over project starts at Auto, and its company counts as allowed without a second admin's confirmation; the upgrade does this itself and records it in the audit log. For any other project, a company admin allows design review and the project's maintainers turn it on, as above. The `designReview.projects` setting itself was removed in 0.5.7 (next entry). (Operators: projects that were not carried over are named in the broker log; see day-two.md.)
- **Reviews use a different company's model by default.** The review steps (plan check, code review, security review) that nobody has configured now use the strongest model from a different AI company than the step they check, when the company has one it can use and that model is at least Sonnet's capability tier; otherwise they behave as before and How we work says so. A running task keeps the review model it was started with. A company owner or admin sees a one-time notice on How we work and can dismiss it for the company; any step can be changed there (turning the "Different vendor" switch off restores the old behaviour for that step).
