#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { open, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Writable as NodeWritable, type Readable, type Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  CLI_COMMAND_NAME,
  AgentXError,
  AgentXNameSchema,
  DEFAULT_ENVIRONMENT,
  ENVIRONMENT_PLACEHOLDER,
  EnvironmentNameSchema,
  INTENT_QUESTIONS_MAX,
  WorkspaceDeploymentModeSchema,
  MODEL_PROVIDERS,
  OrgRoleSchema,
  agentXError,
  type ProjectDefinition,
  type ProjectRole,
} from "@agentx/contracts";
import { DEFAULT_DIRECT_MODELS } from "@agentx/model-runtime/config";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { SSMClient } from "@aws-sdk/client-ssm";
import { STSClient } from "@aws-sdk/client-sts";
import { Command, Option } from "commander";
import { authorizeCredential, expectedAccountEmail, secretsManagerAuthorizeSecrets, type AuthorizeSecrets } from "./admin/authorize.js";
import { fetchStaffRecords, staffExportTransport, staffJustification, staffOrgId } from "./admin/audit.js";
import { budgetText, parseBudgetUsd, setOrgBudget } from "./admin/budget.js";
import { decideEgress, decisionText, listPendingEgress, parseOwnerArgument, pendingText } from "./admin/egress.js";
import { listCredentials, registerCredential } from "./admin/credential.js";
import { requestRuntimeInstallChallenge, submitRuntimeInstallProposal } from "./admin/runtime-installation.js";
import { cliRuntimeBinding, registerProject } from "./admin/register.js";
import { bindSlackChannel, connectSlackTeam, disconnectSlackTeam, unbindSlackChannel } from "./admin/slack.js";
import { stopWorkspace } from "./admin/stop.js";
import { setTaskShareMode } from "./admin/task-share-mode.js";
import { showTaskE2EReplays, startTaskE2EReplay } from "./admin/task-e2e-replay.js";
import { cancelWorkspaceTask } from "./admin/cancel.js";
import { askToApply, exportChanges, runCliChange } from "./admin/changes.js";
import { batchResultsOutput, evalBatchShowText, evalBatchStartText, fetchEvalBatchResults, showEvalBatch, startEvalBatch, stopEvalBatch } from "./admin/eval-batch.js";
import { disableEvalChannel, enableEvalChannel, parseMaxCostUsd, showEvalChannel } from "./admin/eval.js";
import { exportTurns, parseSince } from "./admin/turns.js";
import { loginWithPkce, openSystemBrowser, sanitizeServerText, tokenStoreKey } from "./auth.js";
import { loadProjectConfig } from "./config.js";
import { checkDeveloperProject, projectCheckText } from "./developer/project-check.js";
import { projectCodeSettings } from "./developer/code-settings.js";
import { archiveProjectQuestion, archiveProjectText, changeDeveloperProjectArchive, changeDeveloperProjectSettings, createDeveloperProject, restoreProjectText, createProjectText, developerLogout, projectSettingsText, projectShowText, showDeveloperProject, fetchDeveloperProjects, fetchLinkedIdentities, linkSignInMethod, linkText, logoutText, unlinkSignInMethod, unlinkText, whoamiText, type FreshSignIn } from "./developer/commands.js";
import { resolveDeveloperEnvironment } from "./developer/config.js";
import {
  assertNewFile, auditLogQuery, auditLogText, auditPageUrl, developerExportTransport, exportAuditFile, exportRange, fetchAuditRecords, jsonSafe, verifyAuditExport,
  type AuditLogFlags, type AuditRuntime,
} from "./developer/audit.js";
import { projectSlackBind, projectSlackUnbind, slackBindText, slackUnbindText } from "./developer/slack-channel.js";
import { projectAddMember, projectAddMemberText, projectMembers, projectMembersText, projectRemoveMember, projectRemoveMemberText } from "./developer/project-members.js";
import { orgCommentTriggers, orgCommentTriggersText, orgLeave, orgLeaveQuestion, orgLeaveText, orgMembers, orgMembersText, orgRemove, orgRemoveText, orgRoleText, orgSetRole } from "./developer/org.js";
import { chatGptConnect, chatGptConnectionText, chatGptDisconnect, chatGptDisconnectText, chatGptStatus } from "./developer/chatgpt.js";
import { LOOPBACK_HOSTS, developerLogin } from "./developer/login.js";
import { INVITE_QUESTION, INVITE_QUESTION_NO_BROWSER, askYesByDefault, fetchCurrentOrg, fetchInviteSummary, inviteConfirmationLine, inviteOutcomeText, parseInviteLink, resolveInviteCell } from "./developer/invite-link.js";
import { fetchDeveloperWorkspaces, type DeveloperWorkspacesResult } from "./developer/workspaces.js";
import { runWorkspacesCommand } from "./workspaces-ui/index.js";
import { listAdminWorkspaces } from "./admin/workspaces.js";
import { loadDeploymentSettings, type DeploymentSettings } from "./deployment.js";
import { installMcp, MCP_CLIENTS, runCommand, type McpClientKind, type McpInstallDeps } from "./mcp/install.js";
import { runMcpServer, type McpServeDeps } from "./mcp/serve.js";
import { adminSignInCommand, adminSignInExpiredText, type AdminSession } from "@agentx/mcp";
import { resumeCommand, runDeploy, runInitExport, type DeployCliDependencies, type DeployCommandOptions } from "./deploy/commands.js";
import { cloudFormationStackReader, stsCallerIdentity, type CallerIdentity, type StackReader } from "./environments/adopt.js";
import { resolveDeploymentFile } from "./environments/cache.js";
import { DEFAULT_CLASSIFIER_MODEL, DEFAULT_ORCHESTRATOR_MODEL, DEFAULT_WORKER_MODEL, type InitFlags } from "./init/answers.js";
import { runInit, type InitCliDependencies, type InitOptions } from "./init/commands.js";
import { cliCommandLine, currentCliInvocation, type CliInvocation } from "./init/cli-command.js";
import { StoppedByOperator, isCtrlCAtPrompt } from "./stopped.js";
import { runGithubOauthSet, type GithubOauthServices } from "./github/oauth.js";
import { githubConnect, githubConnectText, githubDisconnect, githubDisconnectText, githubList, githubListText } from "./developer/github.js";
import { secretsManagerInitSecrets, type FinishFlags, type SecretFlags } from "./init/context.js";
import { githubRestApi } from "./init/github-app.js";
import { processPrompter, readHidden } from "./init/prompts.js";
import { cleanConnectionSecret, connectionsAdd, connectionsAddText, connectionsCheck, connectionsCheckText, connectionsList, connectionsListText, connectionsRemove, connectionsRemoveText, parseConnectionAdd } from "./developer/connections.js";
import { INIT_STEP_IDS, type InitStepId } from "./init/install-state.js";
import {
  agentsAccountable, agentsAdopt, agentsArchive, agentsCreate, agentsDiff, agentsDraftGet, agentsDraftSet, agentsList, agentsPublish, agentsRollback, agentsRun,
  agentsShare, agentsShow, agentsUpdateBase, agentsVersions, approvalsConfirmLink, approvalsList, approvalsShow, spendRequestConfirmLink, commentTriggersOptOut, commentTriggersShow,
  guardrailsSet, guardrailsShow, projectAgentsChange, projectConnectorsList, projectConnectorsRemove, projectConnectorsSet, skillsAdd, skillsList, sourcesAdd,
  sourcesCheck, sourcesList, sourcesOrder, sourcesRemove, type AppResult,
} from "./developer/agents.js";
import { hooksCreate, hooksDelete, hooksList, hooksRotate } from "./developer/hooks.js";
import { triggersActivity, triggersList, triggersRemove, triggersSet, type TriggerOwnerKind } from "./developer/triggers.js";
import { chainsArchive, chainsCreate, chainsDraftGet, chainsDraftSet, chainsList, chainsPublish, chainsRollback, chainsShare, chainsShow, chainsVersions } from "./developer/chains.js";
import { homeCards, sessionAnswer, sessionControl, sessionFollow, sessionLinkIssue, sessionMerge, sessionSay, sessionShare, sessionShow, sessionTakeOver, sessionsList } from "./developer/sessions.js";
import { agentsBudget, agentsSpend, orgSpend, projectAiSet, spendRequestsList, taskAskRunLimit, taskContinueAsTask } from "./developer/spend.js";
import { parseConnectorsFlag } from "./init/finish-steps.js";
import { runEnvAdopt, runEnvList, runEnvUse } from "./environments/commands.js";
import { ssmParameterStore, type ParameterStore } from "./environments/parameter-store.js";
import { settingsParameterName, type EnvironmentSettings } from "./environments/settings.js";
import { ReportedFailure, formatError, formatSuccess } from "./output.js";
import { projectModelChecker, realSetupContext, type SetupCommandContext } from "./setup/command-context.js";
import { checkModelsForRegistration } from "./setup/register-model-check.js";
import type { ProjectModelChecker } from "./setup/project-model-check.js";
import { registerSetupCommands } from "./setup/cli.js";
import { registerConfigCommands } from "./config/cli.js";
import type { ConfigServices } from "./config/commands.js";
import { registerDoctorCommand } from "./doctor/cli.js";
import type { DoctorServices } from "./doctor/checks.js";
import { registerSsoCommands } from "./sso/cli.js";
import type { SsoBootstrapServices } from "./sso/bootstrap.js";
import { addSignInOptions, definedEntries, registerSigninCommands, secretSource, signInFlags, type SignInCommandOptions } from "./signin/cli.js";
import { registerDestroyCommand } from "./destroy/cli.js";
import type { DestroyDependencies } from "./destroy/run.js";
import { registerUpgradeCommand } from "./upgrade/cli.js";
import type { UpgradeDependencies } from "./upgrade/run.js";
import { SIGNIN_FLAG_NAMES, type SigninFlags } from "./signin/collect.js";
import type { SigninServices } from "./signin/commands.js";
import { SystemCredentialTokenStore, type TokenStore } from "./token-store.js";
import { CLI_VERSION, RELEASE_VERSION } from "./version.js";
import { registerLoopCommands } from "./loop/cli.js";
import { createDeveloperPublicationJoinTransport, recordRegisteredLoopEnrollment } from "./loop/enrollment-cli.js";
import type { Exec } from "./loop/exec.js";

interface GlobalOptions {
  project?: string;
  configDir: string;
  deploymentFile?: string;
  env: string;
  allowLoopback: boolean;
  acceptUncheckedModel?: string;
  json: boolean;
}

interface TextWriter {
  write(text: string): unknown;
}

export interface CliDependencies {
  /** `admin project register --file`: the single-call model check, for tests; the real one is built from the environment's settings. */
  registerModelCheck?: ProjectModelChecker;
  /**
   * Owner decision 2026-10-02 (#218, #235 follow-up): how this CLI process was launched, for tests;
   * `currentCliInvocation()` otherwise. Shared by the admin sign-in notices, the Ctrl-C stop line,
   * and `agentx mcp`.
   */
  cliInvocation?: CliInvocation;
  fetchImplementation?: typeof fetch;
  /** Waits between polls (`agentx project check`), for tests. Defaults to a timer. */
  sleep?: (ms: number) => Promise<void>;
  tokenStore?: TokenStore;
  stdout?: TextWriter;
  stderr?: TextWriter;
  /** `admin credential authorize` overrides, for tests. */
  authorize?: {
    secrets?: AuthorizeSecrets;
    openBrowser?: (url: string) => Promise<void>;
    listenPort?: number;
    onListening?: (port: number) => void;
  };
  /** Named-environment overrides, for tests: the SSM-backed store, the local cache's home directory, and env adopt's AWS readers. */
  environments?: {
    store?: ParameterStore;
    home?: string;
    sts?: CallerIdentity;
    stacks?: StackReader;
    /**
     * Overrides how `env list` and `env use` build their region-scoped SSM client, for tests: lets
     * a test observe the --region the CLI passed into client construction even when `store` above
     * also overrides the client's actual use, so that override can't quietly bypass the client.
     */
    ssmClient?: (region?: string) => SSMClient;
  };
  /** `agentx deploy` and `agentx init --export` overrides, for tests: never touch AWS. */
  deploy?: DeployCliDependencies;
  /** `agentx init` overrides, for tests: never touch AWS, GitHub or Slack. */
  init?: InitCliDependencies;
  /** `rovara sso` overrides, for tests: never touch AWS. */
  sso?: Partial<SsoBootstrapServices>;
  /** `agentx signin` overrides, for tests: never touch AWS, Slack or an identity provider. */
  signin?: Partial<SigninServices>;
  /** `agentx config` overrides, for tests: never touch AWS. */
  config?: Partial<ConfigServices>;
  /** `agentx doctor` overrides, for tests: never touch AWS or a vendor. */
  doctor?: { store?: ParameterStore; services?: (settings: EnvironmentSettings) => DoctorServices };
  /** `agentx github oauth set` overrides, for tests: never touch AWS or GitHub. */
  githubOauth?: Partial<GithubOauthServices>;
  /** `agentx github connect` polling, for tests. */
  githubConnect?: { pollMs?: number; waitMs?: number };
  /** `agentx upgrade` overrides, for tests: never touch AWS or GitHub. */
  upgrade?: Partial<UpgradeDependencies>;
  /** `agentx destroy` overrides, for tests: never touch AWS. */
  destroy?: Partial<DestroyDependencies>;
  /** `agentx workspaces` overrides, for tests: never reach the control plane or open a browser. */
  workspaces?: {
    read?: () => Promise<DeveloperWorkspacesResult>;
    openBrowser?: (url: string) => Promise<void>;
    waitForExit?: () => Promise<void>;
    isInteractive?: () => boolean;
    port?: number;
  };
  /** `agentx login` overrides, for tests: never open a browser. */
  login?: { openBrowser?: (url: string) => Promise<void> };
  /** `chatgpt connect` overrides, for tests: another port, no browser, and no terminal check. */
  chatgpt?: { port?: number; openBrowser?: (url: string) => Promise<void>; isInteractive?: () => boolean };
  /** `agentx audit` overrides, for tests: no waiting between export polls, fixed request IDs, and no browser. */
  audit?: { sleep?: (ms: number) => Promise<void>; newRequestId?: () => string; openBrowser?: (url: string) => Promise<void> };
  /** `rovara loop` overrides, for tests: every outside program (gh, git, tmux, claude) and how to run this CLI. */
  loop?: { exec?: Exec; cliCommand?: readonly string[] };
  /** `agentx mcp` reads MCP messages from here; process.stdin by default. */
  stdin?: Readable;
  /** `agentx mcp`'s clock for waits, for tests. */
  mcpClock?: McpServeDeps["clock"];
  /** `agentx mcp install`'s runner for the claude command, for tests. */
  runCommand?: McpInstallDeps["run"];
  /** `agentx mcp install`'s Codex settings folder, for tests; CODEX_HOME by default. */
  codexHome?: string;
  /** `agentx project add` and the other setup commands (phase 15d2), for tests: never touch AWS,
   * GitHub, Slack or the control plane. */
  setup?: SetupCommandContext;
  /** The environment `org sources add --key-from-env` reads a provider key from; process.env by default. */
  processEnv?: Readonly<Record<string, string | undefined>>;
  /** Answers the admin change commands' "Apply this change?" prompt, for tests (spec 025 Q6). */
  confirm?(question: string): Promise<boolean>;
}

interface AuthenticatedDeployment {
  settings: DeploymentSettings;
  accessToken: string;
}

/**
 * The AWS SDK clients `env adopt` reads from, scoped to its `--region` (never the ambient default
 * region: adopt must read the deployment in the region the operator names, not wherever the AWS
 * profile happens to point). Exported so a test can assert the region reaches client construction
 * without making any network call (constructing a client, or reading its resolved `config.region`,
 * never calls AWS).
 */
export function environmentAdoptClients(region: string): { ssm: SSMClient; cloudFormation: CloudFormationClient; sts: STSClient } {
  return {
    ssm: new SSMClient({ region }),
    cloudFormation: new CloudFormationClient({ region }),
    sts: new STSClient({ region }),
  };
}

/**
 * The SSM client `env list` and `env use` read from: scoped to an explicit `--region` when given,
 * the ambient AWS configuration otherwise. Exported so a test can assert the region reaches client
 * construction without making any network call, the same way `environmentAdoptClients` is tested.
 */
export function environmentSsmClient(region?: string): SSMClient {
  return new SSMClient(region === undefined ? {} : { region });
}

/**
 * The `login --callback-port` default. `auth.ts`'s loopback listener builds its redirect URI as
 * `http://127.0.0.1:<port>/callback`, so the identity stack's Cognito app client must register a
 * callback URL of `http://127.0.0.1:${DEFAULT_CALLBACK_PORT}/callback` for a login with no
 * `--callback-port` override to work; a test ties the two together.
 */
export const DEFAULT_CALLBACK_PORT = 8765;

export function createCliProgram(dependencies: CliDependencies = {}): Command {
  const services = {
    fetchImplementation: dependencies.fetchImplementation ?? fetch,
    sleep: dependencies.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })),
    tokenStore: dependencies.tokenStore ?? new SystemCredentialTokenStore(),
    stdout: dependencies.stdout ?? process.stdout,
    stderr: dependencies.stderr ?? process.stderr,
  };
  // Owner decision 2026-10-02 (#218, #235 follow-up): how this CLI process was launched (bare, or
  // through npx), the same helper the install ready screen uses, reused for every live message that
  // tells the person the command that runs right now.
  const cliInvocation = dependencies.cliInvocation ?? currentCliInvocation();
  const commandFor = (args: string): string => cliCommandLine(cliInvocation, args);
  // Where `agentx env use` caches settings and, for production only, where the legacy
  // deployment file lives.
  const home = dependencies.environments?.home ?? homedir();
  const parameterStore = (region?: string): ParameterStore => {
    // Always built from the given region, even when a test overrides the store below: env list and
    // env use must read the account/region the operator names, never an ambient default. A test can
    // substitute how this client itself is built (environments.ssmClient) to observe that, the same
    // way env adopt's client construction is independently testable.
    const client = (dependencies.environments?.ssmClient ?? environmentSsmClient)(region);
    return dependencies.environments?.store ?? ssmParameterStore(client);
  };

  /** The deployment settings for the selected --env: an explicit --deployment-file wins, then the environment cache, then, for production only, the legacy ~/.agentx/deployment.yaml. */
  async function deploymentSettings(options: GlobalOptions): Promise<DeploymentSettings> {
    const path = await resolveDeploymentFile({
      home,
      env: options.env,
      ...(options.deploymentFile === undefined ? {} : { explicitFile: options.deploymentFile }),
    });
    return loadDeploymentSettings({ path, allowLoopback: options.allowLoopback, expectedEnv: options.env });
  }

  async function authenticate(
    options: GlobalOptions,
    tokenStore: TokenStore,
  ): Promise<AuthenticatedDeployment> {
    const settings = await deploymentSettings(options);
    const tokens = await tokenStore.get(tokenStoreKey(settings.auth));
    // Issue #218: an expired admin sign-in says so and when, never as if none was ever made.
    if (!tokens) throw agentXError("AUTH_REQUIRED", `this computer holds no admin sign-in for ${options.env}; run ${adminSignInCommand(options.env, commandFor)}`);
    const now = Date.now();
    if (tokens.expiresAt <= now) throw agentXError("AUTH_REQUIRED", adminSignInExpiredText(options.env, tokens.expiresAt, now, commandFor));
    return { settings, accessToken: tokens.accessToken };
  }

  /** This computer's stored admin sign-in (agentx --env <name> login --admin) for an environment by name, expired or not. */
  async function storedAdminSignIn(name: string): Promise<{ baseUrl: string; accessToken: string; expiresAt: number } | undefined> {
    try {
      const settings = await deploymentSettings({ ...globalOptions(program), env: name });
      const tokens = await services.tokenStore.get(tokenStoreKey(settings.auth));
      return tokens === undefined ? undefined : { baseUrl: settings.controlPlaneUrl.replace(/\/$/, ""), accessToken: tokens.accessToken, expiresAt: tokens.expiresAt };
    } catch {
      return undefined;
    }
  }

  /** This computer's unexpired admin sign-in (agentx --env <name> login --admin) for an environment by name. Never refreshed (Q4). */
  async function adminSessionFor(name: string): Promise<(AdminSession & { expiresAt: number }) | undefined> {
    const stored = await storedAdminSignIn(name);
    return stored !== undefined && stored.expiresAt > Date.now() ? stored : undefined;
  }

  /** The developer sign-in's session dependencies: this computer's home and token store. */
  const developerSession = () => ({ home, tokenStore: services.tokenStore, fetch: services.fetchImplementation });

  const program = new Command()
    .name(CLI_COMMAND_NAME)
    .description("Rovara Code: sign in, deploy and administer your coding-agent workspace; hand off tasks from your coding tool or Slack")
    .version(CLI_VERSION)
    .option("--project <project-name>", "select a locally configured AgentX project")
    .option("--config-dir <directory>", "project configuration directory", join(homedir(), ".agentx/projects"))
    .option("--deployment-file <path>", "AgentX deployment settings; defaults to this environment's local cache, or, for production, ~/.agentx/deployment.yaml")
    .option("--env <name>", "AgentX environment", DEFAULT_ENVIRONMENT)
    .option("--allow-loopback", "allow loopback HTTP endpoints for local testing only", false)
    .option("--accept-unchecked-model <reason>", "register a project whose default model failed its check anyway (project add, setup-approve, connector add, admin project register); the reason is recorded with the revision")
    .option("--json", "emit stable machine-readable output", false);

  // Refuse an invalid --env before any command runs, so a malformed name never reaches AWS.
  program.hook("preAction", (_program, actionCommand) => {
    const { env } = actionCommand.optsWithGlobals<GlobalOptions>();
    const parsed = EnvironmentNameSchema.safeParse(env);
    if (!parsed.success) {
      throw agentXError("CONFIG_INVALID", `invalid --env ${JSON.stringify(env)}: ${parsed.error.issues[0]?.message ?? "invalid environment name"}`);
    }
    // EnvironmentNameSchema itself still accepts the placeholder (synthesizing its templates
    // requires that), but it is reserved for published templates, not a real deployment: refuse it
    // here, before any AWS or file access.
    if (parsed.data === ENVIRONMENT_PLACEHOLDER) {
      throw agentXError("CONFIG_INVALID", `--env ${JSON.stringify(env)} is reserved for published templates and cannot be used as a real environment`);
    }
  });

  program
    .command("login")
    .description("sign in: agentx login <url> for developers; agentx login --admin (or no URL) for administrators")
    .argument("[url]", "your AgentX URL, for developer sign-in")
    .option("--admin", "sign in as an administrator with the admin identity provider (the default when no URL is given)", false)
    .option("--no-browser", "developer sign-in: print the sign-in link instead of opening a browser")
    .option("--invite <link>", "join an organization with an invite link (or its code, with the URL): shows what you are joining and asks before opening the browser")
    .option("--yes", "with --invite: open the browser without asking", false)
    .option("--callback-port <port>", "fixed loopback callback port registered with the OIDC client", parsePort, DEFAULT_CALLBACK_PORT)
    .action(async (explicitUrl: string | undefined, options: { admin: boolean; browser: boolean; invite?: string; yes: boolean; callbackPort: number }, command: Command) => {
      const globals = globalOptions(command);
      if ((explicitUrl !== undefined || options.invite !== undefined) && options.admin) {
        throw agentXError("CONFIG_INVALID", options.invite !== undefined ? "use either agentx login --invite <link> (joining an organization) or agentx login --admin, not both" : "use either agentx login <url> (developer sign-in) or agentx login --admin, not both");
      }
      // An invite link names the cell to sign in to (an explicit URL wins), and the person is told what they are joining before a browser opens (ruling R19).
      let url = explicitUrl;
      let invite: string | undefined;
      if (options.invite !== undefined) {
        const parsed = parseInviteLink(options.invite);
        invite = parsed.token;
        const chosen = explicitUrl ?? await resolveInviteCell(parsed, services.fetchImplementation);
        let base: URL;
        try {
          base = new URL(chosen);
        } catch {
          throw agentXError("CONFIG_INVALID", `${chosen} is not a URL; pass your Rovara URL, for example https://abc123.execute-api.us-west-2.amazonaws.com`);
        }
        if (base.protocol !== "https:" && !(globals.allowLoopback && base.protocol === "http:" && LOOPBACK_HOSTS.has(base.hostname))) {
          throw agentXError("CONFIG_INVALID", "your Rovara URL must use https; plain http is allowed only for 127.0.0.1, localhost or ::1 with --allow-loopback");
        }
        const cell = base.origin + base.pathname.replace(/\/+$/, "");
        const summary = await fetchInviteSummary(cell, invite, services.fetchImplementation);
        services.stderr.write(`${inviteConfirmationLine(summary, cell)}\n`);
        if (!options.yes && !await inviteConfirmer()(options.browser ? INVITE_QUESTION : INVITE_QUESTION_NO_BROWSER)) throw agentXError("CONFIRMATION_DECLINED", "you chose not to join; nothing changed");
        url = cell;
      }
      if (url !== undefined) {
        const result = await developerLogin({
          url,
          allowLoopback: globals.allowLoopback,
          browser: options.browser,
          home,
          tokenStore: services.tokenStore,
          fetch: services.fetchImplementation,
          write: (line) => { services.stderr.write(`${line}\n`); },
          ...(dependencies.login?.openBrowser === undefined ? {} : { openBrowser: dependencies.login.openBrowser }),
          ...(invite === undefined ? {} : { invite }),
          ...(command.getOptionValueSource("callbackPort") === "cli" ? { callbackPort: options.callbackPort } : {}),
        });
        // What happened to the invite. The sign-in itself succeeded and its session is kept, but a join that did not happen is a failure:
        // the exact words for why go out as the error (exit 1, and ok: false with the code under --json).
        if (invite !== undefined && result.inviteError !== undefined) {
          const org = result.inviteError === "ALREADY_IN_ORG" ? await fetchCurrentOrg(developerSession(), result.env) : undefined;
          throw agentXError(result.inviteError, inviteOutcomeText(result.inviteError, org));
        }
        const joined = invite === undefined ? undefined : { outcome: "joined", message: inviteOutcomeText("joined", await fetchCurrentOrg(developerSession(), result.env)) };
        const projects = await fetchDeveloperProjects(developerSession(), result.env);
        if (globals.json) {
          services.stdout.write(formatSuccess({ env: projects.env, url: projects.url, ...projects.projects, ...(joined === undefined ? {} : { invite: joined }) }, true));
        } else {
          if (joined !== undefined) services.stdout.write(`${joined.message}\n`);
          services.stdout.write(whoamiText({ ...projects, identities: await fetchLinkedIdentities(developerSession(), result.env) }));
        }
        return;
      }
      // A bare login (or --admin) is today's admin login, unchanged.
      const settings = await deploymentSettings(globals);
      await loginWithPkce({
        issuer: settings.auth.issuer,
        clientId: settings.auth.clientId,
        audience: settings.auth.audience,
        tokenStore: services.tokenStore,
        fetchImplementation: services.fetchImplementation,
        callbackPort: options.callbackPort,
      });
      services.stdout.write(formatSuccess({ controlPlaneUrl: settings.controlPlaneUrl, authenticated: true }, globals.json));
    });

  /** The developer environment: --env when typed, otherwise the default agentx login set. */
  const developerEnv = (command: Command): string | undefined =>
    command.getOptionValueSourceWithGlobals("env") === "cli" ? globalOptions(command).env : undefined;

  program
    .command("logout")
    .description("sign out of AgentX on this computer and end the sign-in at the server; --admin signs out of the admin sign-in")
    .option("--admin", "sign out of the administrator sign-in instead", false)
    .action(async (options: { admin: boolean }, command: Command) => {
      const globals = globalOptions(command);
      if (options.admin) {
        const settings = await deploymentSettings(globals);
        await services.tokenStore.delete(tokenStoreKey(settings.auth));
        services.stdout.write(globals.json ? formatSuccess({ env: globals.env, admin: true }, true) : `Signed out of the admin sign-in for ${globals.env}.\n`);
        return;
      }
      const result = await developerLogout(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess(result, true) : logoutText(result));
    });

  program
    .command("whoami")
    .description("show who you are signed in as and which AgentX projects you can use")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await fetchDeveloperProjects(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, ...result.projects }, true) : whoamiText({ ...result, identities: await fetchLinkedIdentities(developerSession(), developerEnv(command)) }));
    });

  program
    .command("workspaces")
    .description("show your AgentX projects and the workspaces in them, on a page served from 127.0.0.1; --no-ui prints them instead")
    .option("--no-ui", "print the list in the terminal instead of opening a browser")
    .action(async (options: { ui: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const overrides = dependencies.workspaces ?? {};
      const env = developerEnv(command);
      // --json is machine-readable output, so it never opens a browser; neither does a session with
      // no terminal, where nobody is there to see the page open.
      const interactive = (overrides.isInteractive ?? (() => process.stdin.isTTY === true))();
      const ui = options.ui && !globals.json && interactive;
      await runWorkspacesCommand({
        read: overrides.read ?? (() => fetchDeveloperWorkspaces(developerSession(), env)),
        ui,
        json: globals.json,
        stdout: services.stdout,
        stderr: services.stderr,
        openBrowser: overrides.openBrowser ?? openSystemBrowser,
        ...(overrides.waitForExit === undefined ? {} : { waitForExit: overrides.waitForExit }),
        ...(overrides.port === undefined ? {} : { port: overrides.port }),
      });
    });

  // Sign in with ChatGPT (#339): the signed-in developer's own ChatGPT plan, for their tasks.
  const chatgpt = program.command("chatgpt").description("connect your own ChatGPT plan, so your tasks can run on it");
  chatgpt
    .command("connect")
    .description("connect your ChatGPT Plus or Pro plan: signs in with ChatGPT in your browser")
    .option("--no-browser", "print the link instead of opening a browser")
    .action(async (options: { browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const overrides = dependencies.chatgpt ?? {};
      const input = dependencies.stdin ?? process.stdin;
      // Opened only when a paste is offered, so a run without a terminal never holds stdin.
      let lines: AsyncIterator<string> | undefined;
      try {
        const result = await chatGptConnect(developerSession(), developerEnv(command), {
          browser: options.browser,
          openBrowser: overrides.openBrowser ?? openSystemBrowser,
          write: (line) => { services.stderr.write(`${line}\n`); },
          readLine: async () => {
            lines ??= createInterface({ input, terminal: false })[Symbol.asyncIterator]();
            const next = await lines.next();
            return next.done === true ? undefined : next.value;
          },
          interactive: (overrides.isInteractive ?? (() => process.stdin.isTTY === true))(),
          ...(overrides.port === undefined ? {} : { port: overrides.port }),
        });
        services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, ...result.connection }, true) : chatGptConnectionText(result, "connected"));
      } finally {
        await lines?.return?.();
      }
    });
  chatgpt
    .command("status")
    .description("show whether your ChatGPT plan is connected, and the models it offers")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await chatGptStatus(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, ...result.connection }, true) : chatGptConnectionText(result, "status"));
    });
  chatgpt
    .command("disconnect")
    .description("disconnect your ChatGPT plan; your tasks go back to this environment's default model")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await chatGptDisconnect(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, ...result.connection }, true) : chatGptDisconnectText(result));
    });

  /** The fresh sign-in `signin unlink`, `signin link` and `audit export` run when the server asks for one: today's developer login, then the request again. */
  const freshSignInFor = (command: Command, browser: boolean): FreshSignIn => async ({ url, exclude, reason }) => {
    services.stderr.write(`This needs a fresh sign-in (${reason}). Signing in again now.\n`);
    await developerLogin({
      url, allowLoopback: globalOptions(command).allowLoopback, browser, home, tokenStore: services.tokenStore, fetch: services.fetchImplementation,
      write: (line) => { services.stderr.write(`${line}\n`); },
      ...(dependencies.login?.openBrowser === undefined ? {} : { openBrowser: dependencies.login.openBrowser }),
      ...(exclude === undefined ? {} : { excludeMethod: exclude }),
      fresh: true,
    });
  };
  // The audit log (Task 14): an organization's owners and admins read, export and check it with their own sign-in.
  const auditRuntime = (): AuditRuntime => ({
    fetch: services.fetchImplementation,
    sleep: dependencies.audit?.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })),
    newRequestId: dependencies.audit?.newRequestId ?? randomUUID,
  });
  const collectTrust = (value: string, previous: string[]): string[] => [...previous, value];
  const audit = program.command("audit").description("read, export and check your organization's audit log (organization owners and admins)");
  audit
    .command("log")
    .description("show the records of your organization's audit log, with the names of the people in them")
    .option("--from <record-or-time>", "start at this record number, or at this time, such as 2026-10-20T12:00:00Z")
    .option("--to <record-or-time>", "stop at this record number, or at this time")
    .option("--action <action>", "only records of this action, such as member.invited")
    .option("--limit <count>", "how many records to show, 1 to 200 (50 by default)")
    .option("--cursor <cursor>", "continue after the last page, with the cursor it printed")
    .action(async (options: AuditLogFlags, command: Command) => {
      const globals = globalOptions(command);
      const result = await fetchAuditRecords(developerSession(), developerEnv(command), auditLogQuery(options));
      services.stdout.write(globals.json ? formatSuccess(jsonSafe({ env: result.env, url: result.url, ...result.records }), true) : auditLogText(result.records));
    });
  audit
    .command("export")
    .description("export a range of records to a file you can keep and check without trusting Rovara")
    .option("--from <record>", "the first record number to export")
    .option("--to <record>", "the last record number to export (at most 200,000 records)")
    .option("--with-details", "include the names and other personal details", false)
    .option("--out <file>", "where to save the export; it is never written over an existing file")
    .option("--no-browser", "if a fresh sign-in is needed (an export needs a sign-in from the last 10 minutes), print the sign-in link instead of opening a browser")
    .action(async (options: { from?: string; to?: string; withDetails: boolean; out?: string; browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const range = exportRange(options.from, options.to);
      if (options.out === undefined) throw agentXError("CONFIG_INVALID", "say where to save the export: --out <file>");
      services.stdout.write(await exportAuditFile(developerExportTransport(developerSession(), developerEnv(command), freshSignInFor(command, options.browser)), auditRuntime(), {
        ...range, withDetails: options.withDetails, out: resolve(options.out), json: globals.json,
      }));
    });
  audit
    .command("verify")
    .description("export a range without details and check it here: its chain, seals and timestamps, and with --extends that it continues an older export of yours")
    .option("--from <record>", "the first record number to check")
    .option("--to <record>", "the last record number to check (at most 200,000 records)")
    .option("--extends <file>", "an older export you kept: check that this one keeps its history")
    .option("--trust <label=pem-file>", "trust this root certificate for the timestamp authority with this label (repeatable)", collectTrust, [] as string[])
    .option("--out <file>", "also keep the export you checked")
    .option("--no-browser", "if a fresh sign-in is needed (checking starts an export, which needs a sign-in from the last 10 minutes), print the sign-in link instead of opening a browser")
    .action(async (options: { from?: string; to?: string; extends?: string; trust: string[]; out?: string; browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const range = exportRange(options.from, options.to);
      const result = await verifyAuditExport(developerExportTransport(developerSession(), developerEnv(command), freshSignInFor(command, options.browser)), auditRuntime(), {
        ...range, trust: options.trust, extendsPath: options.extends, out: options.out === undefined ? undefined : resolve(options.out), json: globals.json,
      });
      services.stdout.write(result.text);
      if (!result.ok) throw new ReportedFailure("VERIFICATION_FAILED", "This export did not pass verification; the report says which checks failed.");
    });
  audit
    .command("open")
    .description("open the audit log page of your organization in your browser")
    .option("--no-browser", "print the link instead of opening a browser")
    .action(async (options: { browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const url = await auditPageUrl({ home }, developerEnv(command));
      if (options.browser) await (dependencies.audit?.openBrowser ?? openSystemBrowser)(url).catch(() => undefined);
      services.stdout.write(globals.json ? formatSuccess({ url }, true) : `${options.browser ? "Opening" : "Open"} the audit log page: ${url}\nSign in there with the account you use for your organization.\n`);
    });

  // Plan 2, Task 4: the people in your organization.
  const org = program.command("org").description("the people in your organization");
  org
    .command("members")
    .description("list the members of your organization, with their roles")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await orgMembers(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, members: result.members }, true) : orgMembersText(result));
    });
  org
    .command("role")
    .description("change a member's role (owners only)")
    .argument("<email-or-id>", "the member's email or developer ID, from agentx org members")
    .argument("<role>", "owner, admin or member")
    .action(async (who: string, role: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const parsed = OrgRoleSchema.safeParse(role);
      if (!parsed.success) throw agentXError("CONFIG_INVALID", "the role must be owner, admin or member");
      const result = await orgSetRole(developerSession(), developerEnv(command), who, parsed.data);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, developerId: result.member.developerId, role: result.role }, true) : orgRoleText(result));
    });
  org
    .command("remove")
    .description("remove a member from your organization: their sessions end and their running tasks stop after their current step")
    .argument("<email-or-id>", "the member's email or developer ID, from agentx org members")
    .action(async (who: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await orgRemove(developerSession(), developerEnv(command), who);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, developerId: result.member.developerId, message: result.message }, true) : orgRemoveText(result));
    });
  org
    .command("leave")
    .description("leave your organization; as its only member this closes it and releases its GitHub connection")
    .option("--yes", "leave without asking", false)
    .action(async (options: { yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const env = developerEnv(command);
      const confirm = changeConfirmer(options.yes);
      const { question } = await orgLeaveQuestion(developerSession(), env);
      if (!await confirm(question)) throw agentXError("CONFIRMATION_DECLINED", "you did not leave the organization; nothing changed");
      const result = await orgLeave(developerSession(), env);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, orgClosed: result.orgClosed, message: result.message }, true) : orgLeaveText(result));
    });

  // Plan 3, Task 12b: the Linear, Jira and MCP connections of your organization (an owner or admin changes them; any member lists them).
  const connections = program.command("connections").description("the Linear, Jira and MCP connections your organization has given Rovara");
  connections
    .command("list")
    .description("list your organization's connections: what each is, whether a credential is saved and what the last check found")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await connectionsList(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, connections: result.connections }, true) : connectionsListText(result));
    });
  connections
    .command("add")
    .description("add a connection (an organization owner or admin); the key or token is read from standard input, hidden on a terminal, and never shown again")
    .argument("<type>", "linear, jira or mcp")
    .option("--label <name>", "a name people recognize it by, such as \"Team Linear\"")
    .option("--access <access>", "read or read_write: what Rovara's agents may do with it", "read")
    .option("--site-url <url>", "jira: your Jira Cloud site, https://<site>.atlassian.net")
    .option("--email <email>", "jira: the Atlassian account email the API token belongs to")
    .option("--endpoint <url>", "mcp: the MCP server's https URL")
    .option("--vendor <name>", "mcp: who runs the server, such as Sentry")
    .option("--auth-header <name>", "mcp: the header that carries the token, if not Authorization")
    .option("--auth-prefix <text>", "mcp: what goes before the token in that header, if not \"Bearer \"")
    .action(async (type: string, options: { label?: string; access?: string; siteUrl?: string; email?: string; endpoint?: string; vendor?: string; authHeader?: string; authPrefix?: string }, command: Command) => {
      const globals = globalOptions(command);
      // Every option is checked before the secret is asked for, so a typo costs no paste.
      const parsed = parseConnectionAdd({ type, ...options });
      const secret = cleanConnectionSecret(await readHidden(dependencies.stdin ?? process.stdin, services.stderr, `${parsed.secretName} (hidden): `), parsed.secretName);
      const result = await connectionsAdd(developerSession(), developerEnv(command), parsed, secret);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, connection: result.connection }, true) : connectionsAddText(result));
    });
  connections
    .command("remove")
    .description("remove a connection (an organization owner or admin); its secret is scheduled for deletion and can be recovered for 7 days")
    .argument("<connection-id>", "the connection's ID, from agentx connections list")
    .option("--yes", "remove without asking", false)
    .action(async (connectionId: string, options: { yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const confirm = changeConfirmer(options.yes);
      if (!await confirm(`Remove the connection ${sanitizeServerText(connectionId)}? Agents that use it stop working.`)) throw agentXError("CONFIRMATION_DECLINED", "you did not remove the connection; nothing changed");
      const result = await connectionsRemove(developerSession(), developerEnv(command), connectionId);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, connectionId: result.connectionId }, true) : connectionsRemoveText(result));
    });
  connections
    .command("check")
    .description("test a connection with its saved secret (an organization owner or admin)")
    .argument("<connection-id>", "the connection's ID, from agentx connections list")
    .action(async (connectionId: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await connectionsCheck(developerSession(), developerEnv(command), connectionId);
      if (!result.ok) throw new ReportedFailure("CONNECTION_CHECK_FAILED", `The connection ${sanitizeServerText(connectionId)} did not pass its check${result.message === undefined ? "" : `: ${sanitizeServerText(result.message)}`}.`);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, connectionId: result.connectionId, ok: true, ...(result.message === undefined ? {} : { message: result.message }) }, true) : connectionsCheckText(result));
    });

  // Plan 3, Task 14b: the repositories opted out of the comment-triggered workflow rule. Setting one is an org admin's request on the project and a
  // confirmation on the page; no command here (or MCP tool) sets or confirms one.
  org
    .command("comment-triggers")
    .description("the repositories an org admin opted out of the rule that agent comments wait for a person where workflows act on comments")
    .command("list")
    .description("list the active opt-outs: project, repository, the digest of the workflows that were reviewed, who reviewed them and why")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await orgCommentTriggers(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess(jsonSafe({ env: result.env, url: result.url, commentTriggerOptOuts: result.optOuts }), true) : orgCommentTriggersText(result));
    });

  // Plan 3, Task 35a: the agent platform. Each command is a call to the /v1/app routes; a refusal prints the broker's words. Nothing here
  // decides an approval, a spend request or an opt-out (R66): those are decided by a person on the confirmation page.
  const printResult = (command: Command, result: AppResult) => {
    services.stdout.write(globalOptions(command).json ? formatSuccess({ env: result.env, url: result.url, ...result.data }, true) : result.text);
  };
  const chains = program.command("chains").description("design, publish, share and roll back chains of agents and approval gates");
  chains
    .command("list")
    .description("list the chains you can see: all, yours, those shared with you, or a project's")
    .option("--mine", "only chains you own", false)
    .option("--shared", "only chains shared with you", false)
    .option("--project <name>", "the chains of a project")
    .action(async (options: { mine: boolean; shared: boolean; project?: string }, command: Command) => {
      const scopes = (["mine", "shared"] as const).filter((scope) => options[scope]);
      const project = options.project ?? globalOptions(command).project;
      if (scopes.length + (project === undefined ? 0 : 1) > 1) throw agentXError("CONFIG_INVALID", "give one of --mine, --shared and --project");
      printResult(command, await chainsList(developerSession(), developerEnv(command), { ...(scopes[0] === undefined ? {} : { scope: scopes[0] }), ...(project === undefined ? {} : { project }) }));
    });
  chains
    .command("show")
    .description("show a chain: what runs now and its steps")
    .argument("<chain-id>", "the chain's ID, from agentx chains list")
    .action(async (chainId: string, _options: unknown, command: Command) => printResult(command, await chainsShow(developerSession(), developerEnv(command), chainId)));
  chains
    .command("create")
    .description("create a chain, yours or a project's, from a design file (or a one-step starter)")
    .option("--name <name>", "the chain's name")
    .option("--description <text>", "what the chain is for")
    .option("--file <definition.json>", "the design, as JSON")
    .option("--project-owner <project>", "make it the project's chain rather than yours")
    .option("--accountable <email-or-id>", "with --project-owner: the maintainer who answers for it")
    .action(async (options: { name?: string; description?: string; file?: string; projectOwner?: string; accountable?: string }, command: Command) =>
      printResult(command, await chainsCreate(developerSession(), developerEnv(command), options)));
  const chainDraft = chains.command("draft").description("a chain's draft: the design that is published next");
  chainDraft
    .command("get")
    .description("print the draft's design, its revision and the problems that stop it being published")
    .argument("<chain-id>", "the chain's ID")
    .action(async (chainId: string, _options: unknown, command: Command) => printResult(command, await chainsDraftGet(developerSession(), developerEnv(command), chainId)));
  chainDraft
    .command("set")
    .description("save a design as the draft; refused if someone changed the draft since it was read")
    .argument("<chain-id>", "the chain's ID")
    .option("--file <definition.json>", "the design, as JSON")
    .action(async (chainId: string, options: { file?: string }, command: Command) => printResult(command, await chainsDraftSet(developerSession(), developerEnv(command), chainId, options.file)));
  chains
    .command("publish")
    .description("publish the draft as the chain's next version; a less safe change waits for a person on the confirmation page")
    .argument("<chain-id>", "the chain's ID")
    .option("--note <text>", "what changed, up to 200 characters")
    .action(async (chainId: string, options: { note?: string }, command: Command) => printResult(command, await chainsPublish(developerSession(), developerEnv(command), chainId, options.note)));
  chains
    .command("versions")
    .description("list a chain's published versions")
    .argument("<chain-id>", "the chain's ID")
    .action(async (chainId: string, _options: unknown, command: Command) => printResult(command, await chainsVersions(developerSession(), developerEnv(command), chainId)));
  chains
    .command("rollback")
    .description("run an earlier published version again; a less safe one waits for a person on the confirmation page")
    .argument("<chain-id>", "the chain's ID")
    .argument("<version>", "the version to run")
    .action(async (chainId: string, version: string, _options: unknown, command: Command) => printResult(command, await chainsRollback(developerSession(), developerEnv(command), chainId, version)));
  for (const archive of [true, false]) {
    chains
      .command(archive ? "archive" : "unarchive")
      .description(archive ? "archive a chain: it stops starting runs" : "bring an archived chain back")
      .argument("<chain-id>", "the chain's ID")
      .action(async (chainId: string, _options: unknown, command: Command) => printResult(command, await chainsArchive(developerSession(), developerEnv(command), chainId, archive)));
  }
  chains
    .command("share")
    .description("set who a chain is shared with, from a JSON list of { principal, level }")
    .argument("<chain-id>", "the chain's ID")
    .option("--file <shares.json>", "the shares, as a JSON array")
    .action(async (chainId: string, options: { file?: string }, command: Command) => printResult(command, await chainsShare(developerSession(), developerEnv(command), chainId, options.file)));

  // Plan 5, Task 23: sessions. A take-over and a company-wide share answer 202 with a link to confirm in a browser: it is printed, never retried as a sign-in.
  program
    .command("sessions")
    .description("list sessions: yours by default, those shared with you, a project's, or the Live wall for a filter")
    .option("--mine", "sessions you own (the default)", false)
    .option("--shared", "sessions shared with you", false)
    .option("--project <name>", "a project's sessions; with --live, the Live wall of that project")
    .option("--live <filter>", "the Live wall: all, mine, team, needs_me or failed")
    .option("--cursor <cursor>", "continue a list from the cursor it printed")
    .action(async (options: { mine: boolean; shared: boolean; project?: string; live?: string; cursor?: string }, command: Command) => {
      const project = options.project ?? globalOptions(command).project;
      printResult(command, await sessionsList(developerSession(), developerEnv(command), {
        mine: options.mine, shared: options.shared, ...(project === undefined ? {} : { project }), ...(options.live === undefined ? {} : { live: options.live }), ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
      }));
    });
  const session = program.command("session").description("look at one session, comment on it, tell its agent, answer its questions, stop it, retry it, take it over, share it, link it to a Linear issue or press Merge on its pull request");
  session
    .command("show")
    .description("show a session: its link, status, owner, cost and what waits for you")
    .argument("<session-id>", "the session's ID, from agentx sessions")
    .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionShow(developerSession(), developerEnv(command), id)));
  for (const follow of [true, false]) {
    session
      .command(follow ? "follow" : "unfollow")
      .description(follow ? "follow a session: you are told when it needs you" : "stop following a session")
      .argument("<session-id>", "the session's ID")
      .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionFollow(developerSession(), developerEnv(command), id, follow)));
  }
  session
    .command("comment")
    .description("write a comment on a session, for the people on it (the agent does not read it)")
    .argument("<session-id>", "the session's ID")
    .argument("<text>", "the comment")
    .action(async (id: string, text: string, _options: unknown, command: Command) => printResult(command, await sessionSay(developerSession(), developerEnv(command), id, "comment", text)));
  session
    .command("tell")
    .description("send a message to the session's agent; it needs \"can use\" on the session. To answer Rovara's questions use session answer")
    .argument("<session-id>", "the session's ID")
    .argument("<text>", "the message")
    .action(async (id: string, text: string, _options: unknown, command: Command) => printResult(command, await sessionSay(developerSession(), developerEnv(command), id, "steer", text)));
  // Rovara Code's questions (Plan 6 Task 5, Task 25): `--q1` answers question 1, `--q2` question 2 (an option's letter or words, or your own words).
  const answerCommand = session
    .command("answer")
    .description("answer the questions Rovara Code asked before it plans; with no --qN it shows the questions. It needs \"can use\" on the session")
    .argument("<task-or-session>", "the session's ID (from agentx sessions) or the task's ID");
  for (let number = 1; number <= INTENT_QUESTIONS_MAX; number += 1) answerCommand.option(`--q${number} <answer>`, `the answer to question ${number}: an option's letter or words, or your own words ("your call" leaves it to Rovara)`);
  answerCommand.action(async (ref: string, options: Record<string, string | undefined>, command: Command) =>
    printResult(command, await sessionAnswer(developerSession(), developerEnv(command), ref, { answers: Array.from({ length: INTENT_QUESTIONS_MAX }, (_unused, index) => options[`q${index + 1}`]) })));
  for (const action of ["stop", "retry"] as const) {
    session
      .command(action)
      .description(action === "stop" ? "stop a session's work; the session stays open" : "retry a session that failed or was cancelled")
      .argument("<session-id>", "the session's ID")
      .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionControl(developerSession(), developerEnv(command), id, action)));
  }
  session
    .command("take-over")
    .description("ask to take a session over; you confirm it in your browser from the link this prints")
    .argument("<session-id>", "the session's ID")
    .action(async (id: string, _options: unknown, command: Command) => printResult(command, await sessionTakeOver(developerSession(), developerEnv(command), id)));
  session
    .command("share")
    .description("share a session with a person, a project or the company (the company share is confirmed in your browser)")
    .argument("<session-id>", "the session's ID")
    .option("--with <who>", "an email or developer ID, project:<name>, or company")
    .option("--level <level>", "view, use or edit")
    .action(async (id: string, options: { with?: string; level?: string }, command: Command) =>
      printResult(command, await sessionShare(developerSession(), developerEnv(command), id, { ...(options.with === undefined ? {} : { with: options.with }), ...(options.level === undefined ? {} : { level: options.level }) })));
  session
    .command("merge")
    .description("press Merge for a Rovara Code task: shows what is approved and whether checks passed, asks, then prints the link where you confirm it in your browser")
    .argument("<task-or-session>", "the session's ID (from agentx sessions) or the task's ID")
    .option("--yes", "press without asking; you still confirm in your browser", false)
    .action(async (ref: string, options: { yes: boolean }, command: Command) =>
      printResult(command, await sessionMerge(developerSession(), developerEnv(command), ref, { confirm: changeConfirmer(options.yes) })));
  session
    .command("link")
    .description("link a Rovara Code session to a Linear issue, so its pull request says Fixes <KEY>; needs \"can edit\" on the session")
    .argument("<task-or-session>", "the session's ID (from agentx sessions) or the task's ID")
    .option("--linear <issue>", "the Linear issue's key (like TEAM-123) or its linear.app link")
    .option("--replace", "change the issue when the session already follows another", false)
    .option("--unlink", "let go of the session's Linear issue", false)
    .action(async (ref: string, options: { linear?: string; replace: boolean; unlink: boolean }, command: Command) =>
      printResult(command, await sessionLinkIssue(developerSession(), developerEnv(command), ref, { ...(options.linear === undefined ? {} : { linear: options.linear }), replace: options.replace, unlink: options.unlink })));
  program
    .command("home")
    .description("what needs you now: approvals, plans, spend requests, pull requests and failures")
    .action(async (_options: unknown, command: Command) => printResult(command, await homeCards(developerSession(), developerEnv(command))));

  /** `agentx chains triggers ...` and `agentx agents triggers ...`: the same four commands on a chain and on an agent (Plan 4 Task 18). */
  const addTriggerCommands = (parent: Command, kind: TriggerOwnerKind, noun: string) => {
    const triggers = parent.command("triggers").description(`what starts a ${noun} without a person: events and schedules`);
    triggers
      .command("list")
      .description(`list a ${noun}'s triggers`)
      .argument(`<${noun}-id>`, `the ${noun}'s ID`)
      .action(async (id: string, _options: unknown, command: Command) => printResult(command, await triggersList(developerSession(), developerEnv(command), kind, id)));
    triggers
      .command("set")
      .description("add a trigger or change one; turning one on waits for a person on the confirmation page")
      .argument(`<${noun}-id>`, `the ${noun}'s ID`)
      .option("--trigger-id <id>", "the trigger to change; without it a new one is added")
      .option("--project <name>", "the project the trigger works on")
      .option("--file <spec.json>", "what starts it, as JSON: an event or a schedule")
      .option("--hook <hook-id>", "the hook that receives the events of a source other than GitHub")
      .option("--max-runs-per-hour <n>", "the most runs it may start in an hour")
      .option("--off", "store it turned off", false)
      .action(async (id: string, options: { triggerId?: string; project?: string; file?: string; hook?: string; maxRunsPerHour?: string; off: boolean }, command: Command) =>
        printResult(command, await triggersSet(developerSession(), developerEnv(command), kind, id, {
          ...(options.triggerId === undefined ? {} : { triggerId: options.triggerId }), ...((options.project ?? globalOptions(command).project) === undefined ? {} : { project: (options.project ?? globalOptions(command).project)! }),
          ...(options.file === undefined ? {} : { file: options.file }), ...(options.hook === undefined ? {} : { hookId: options.hook }),
          ...(options.maxRunsPerHour === undefined ? {} : { maxRunsPerHour: options.maxRunsPerHour }), ...(options.off ? { enabled: false } : {}),
        })));
    triggers
      .command("remove")
      .description("delete a trigger")
      .argument(`<${noun}-id>`, `the ${noun}'s ID`)
      .argument("<trigger-id>", "the trigger's ID, from the list")
      .action(async (id: string, triggerId: string, _options: unknown, command: Command) => printResult(command, await triggersRemove(developerSession(), developerEnv(command), kind, id, triggerId)));
    triggers
      .command("activity")
      .description("what a trigger did lately: the runs it started and why it skipped or was turned off")
      .argument(`<${noun}-id>`, `the ${noun}'s ID`)
      .argument("<trigger-id>", "the trigger's ID, from the list")
      .action(async (id: string, triggerId: string, _options: unknown, command: Command) => printResult(command, await triggersActivity(developerSession(), developerEnv(command), kind, id, triggerId)));
  };
  addTriggerCommands(chains, "chains", "chain");
  const agents = program.command("agents").description("build, publish, share, run and govern your organization's agents");
  addTriggerCommands(agents, "agents", "agent");
  agents
    .command("list")
    .description("list the agents you can see: all, yours, those shared with you, the built-in ones, or a project's")
    .option("--mine", "only agents you own", false)
    .option("--shared", "only agents shared with you", false)
    .option("--builtin", "only the built-in agents", false)
    .option("--project <name>", "the agents that work on a project")
    .action(async (options: { mine: boolean; shared: boolean; builtin: boolean; project?: string }, command: Command) => {
      const scopes = (["mine", "shared", "builtin"] as const).filter((scope) => options[scope]);
      const project = options.project ?? globalOptions(command).project;
      if (scopes.length + (project === undefined ? 0 : 1) > 1) throw agentXError("CONFIG_INVALID", "give one of --mine, --shared, --builtin and --project");
      printResult(command, await agentsList(developerSession(), developerEnv(command), { ...(scopes[0] === undefined ? {} : { scope: scopes[0] }), ...(project === undefined ? {} : { project }) }));
    });
  agents
    .command("show")
    .description("show an agent: what runs now, whether the draft has changed, its budget")
    .argument("<agent-id>", "the agent's ID, from agentx agents list")
    .action(async (agentId: string, _options: unknown, command: Command) => printResult(command, await agentsShow(developerSession(), developerEnv(command), agentId)));
  agents
    .command("create")
    .description("create an agent, yours or a project's, optionally building on another")
    .option("--name <name>", "the agent's name")
    .option("--description <text>", "what the agent is for")
    .option("--extends <agent-id>", "the agent it builds on, such as code-reviewer")
    .option("--project-owner <project>", "make it the project's agent rather than yours")
    .option("--accountable <email-or-id>", "with --project-owner: the maintainer who answers for it")
    .action(async (options: { name?: string; description?: string; extends?: string; projectOwner?: string; accountable?: string }, command: Command) =>
      printResult(command, await agentsCreate(developerSession(), developerEnv(command), options)));
  const draft = agents.command("draft").description("an agent's draft: the overlay that is published next");
  draft
    .command("get")
    .description("print the draft's overlay and revision")
    .argument("<agent-id>", "the agent's ID")
    .action(async (agentId: string, _options: unknown, command: Command) => printResult(command, await agentsDraftGet(developerSession(), developerEnv(command), agentId)));
  draft
    .command("set")
    .description("save an overlay as the draft; refused if someone changed the draft since it was read")
    .argument("<agent-id>", "the agent's ID")
    .option("--file <overlay.json>", "the overlay, as JSON")
    .action(async (agentId: string, options: { file?: string }, command: Command) => printResult(command, await agentsDraftSet(developerSession(), developerEnv(command), agentId, options.file)));
  agents
    .command("publish")
    .description("publish the draft as the agent's next version; a less safe change waits for a person on the confirmation page")
    .argument("<agent-id>", "the agent's ID")
    .option("--note <text>", "what changed, up to 200 characters")
    .action(async (agentId: string, options: { note?: string }, command: Command) => printResult(command, await agentsPublish(developerSession(), developerEnv(command), agentId, options.note)));
  agents
    .command("versions")
    .description("list an agent's published versions")
    .argument("<agent-id>", "the agent's ID")
    .action(async (agentId: string, _options: unknown, command: Command) => printResult(command, await agentsVersions(developerSession(), developerEnv(command), agentId)));
  agents
    .command("diff")
    .description("what differs between two versions of an agent")
    .argument("<agent-id>", "the agent's ID")
    .argument("<from>", "a version number, base or draft")
    .argument("<to>", "a version number or draft")
    .action(async (agentId: string, from: string, to: string, _options: unknown, command: Command) => printResult(command, await agentsDiff(developerSession(), developerEnv(command), agentId, from, to)));
  agents
    .command("rollback")
    .description("run an earlier published version again")
    .argument("<agent-id>", "the agent's ID")
    .argument("<version>", "the version to run")
    .action(async (agentId: string, version: string, _options: unknown, command: Command) => printResult(command, await agentsRollback(developerSession(), developerEnv(command), agentId, version)));
  agents
    .command("update-base")
    .description("move the draft to the latest version of the agent it builds on")
    .argument("<agent-id>", "the agent's ID")
    .action(async (agentId: string, _options: unknown, command: Command) => printResult(command, await agentsUpdateBase(developerSession(), developerEnv(command), agentId)));
  agents
    .command("adopt")
    .description("run a newer version of a built-in agent across your organization (an org owner or admin)")
    .argument("<builtin-id>", "the built-in agent, such as code-reviewer")
    .argument("<version>", "the version to adopt")
    .action(async (builtinId: string, version: string, _options: unknown, command: Command) => printResult(command, await agentsAdopt(developerSession(), developerEnv(command), builtinId, version)));
  agents
    .command("share")
    .description("set who an agent is shared with, from a JSON list of { principal, level }")
    .argument("<agent-id>", "the agent's ID")
    .option("--file <shares.json>", "the shares, as a JSON array")
    .action(async (agentId: string, options: { file?: string }, command: Command) => printResult(command, await agentsShare(developerSession(), developerEnv(command), agentId, options.file)));
  for (const archive of [true, false]) {
    agents
      .command(archive ? "archive" : "unarchive")
      .description(archive ? "archive an agent: it stops running" : "bring an archived agent back")
      .argument("<agent-id>", "the agent's ID")
      .action(async (agentId: string, _options: unknown, command: Command) => printResult(command, await agentsArchive(developerSession(), developerEnv(command), agentId, archive)));
  }
  agents
    .command("accountable")
    .description("name the person who answers for a project's agent or a built-in one")
    .argument("<agent-id>", "the agent's ID")
    .argument("<email-or-id>", "the person's email or developer ID, from agentx org members")
    .action(async (agentId: string, who: string, _options: unknown, command: Command) => printResult(command, await agentsAccountable(developerSession(), developerEnv(command), agentId, who)));
  agents
    .command("budget")
    .description("set an agent's monthly budget and the most one run may spend, in US dollars (none clears it)")
    .argument("<agent-id>", "the agent's ID")
    .option("--monthly <usd|none>", "the agent's monthly budget")
    .option("--max-per-run <usd|none>", "the most one run may spend")
    .action(async (agentId: string, options: { monthly?: string; maxPerRun?: string }, command: Command) => printResult(command, await agentsBudget(developerSession(), developerEnv(command), agentId, options)));
  agents
    .command("spend")
    .description("what an agent has spent this month, where its runs came from, and its latest runs")
    .argument("<agent-id>", "the agent's ID")
    .option("--month <YYYY-MM>", "a month other than this one")
    .action(async (agentId: string, options: { month?: string }, command: Command) => printResult(command, await agentsSpend(developerSession(), developerEnv(command), agentId, options)));
  agents
    .command("run")
    .description("start a run of an agent on a project; --version <n> runs a published version, --draft the draft as a test run")
    .argument("<agent-id>", "the agent's ID")
    .option("--project <name>", "the project to run it on")
    .option("--input <text>", "what the agent is asked")
    .option("--draft", "run the draft, as a test run", false)
    // `--version <n>` is the program's own flag; executeCli hands it to this command as --run-version.
    .addOption(new Option("--run-version <n>", "the published version to run").hideHelp())
    .action(async (agentId: string, options: { project?: string; input?: string; draft: boolean; runVersion?: string }, command: Command) => {
      const project = options.project ?? globalOptions(command).project;
      printResult(command, await agentsRun(developerSession(), developerEnv(command), agentId, {
        draft: options.draft, ...(project === undefined ? {} : { project }), ...(options.input === undefined ? {} : { input: options.input }), ...(options.runVersion === undefined ? {} : { version: options.runVersion }),
      }));
    });

  const skills = program.command("skills").description("your organization's skills (SKILL.md files agents can use)");
  skills
    .command("add")
    .description("add a skill from a SKILL.md file")
    .option("--file <SKILL.md>", "the skill's SKILL.md")
    .action(async (options: { file?: string }, command: Command) => printResult(command, await skillsAdd(developerSession(), developerEnv(command), options.file)));
  skills
    .command("list")
    .description("list your organization's skills")
    .action(async (_options: unknown, command: Command) => printResult(command, await skillsList(developerSession(), developerEnv(command))));

  // R66: an approval is read here and decided only by a person on its confirmation page; there is no approve, decline or deny command.
  const approvals = program.command("approvals").description("what waits for your approval; you approve or decline on each one's confirmation page");
  approvals
    .command("list")
    .description("list the approvals waiting for you")
    .action(async (_options: unknown, command: Command) => printResult(command, await approvalsList(developerSession(), developerEnv(command))));
  approvals
    .command("show")
    .description("show one approval: what it would do, its full arguments and its confirmation link")
    .argument("<approval-id>", "the approval's ID, from agentx approvals list")
    .action(async (approvalId: string, _options: unknown, command: Command) => printResult(command, await approvalsShow(developerSession(), developerEnv(command), approvalId)));
  approvals
    .command("open")
    .description("open an approval's confirmation page in your browser, where you approve or decline it")
    .argument("<approval-id>", "the approval's ID, from agentx approvals list")
    .option("--no-browser", "print the link instead of opening a browser")
    .action(async (approvalId: string, options: { browser: boolean }, command: Command) => {
      const link = await approvalsConfirmLink(developerSession(), developerEnv(command), approvalId);
      printResult(command, link);
      if (options.browser && link.openUrl !== undefined) await (dependencies.login?.openBrowser ?? openSystemBrowser)(link.openUrl).catch(() => undefined);
    });

  // R66: a spend request is read here and decided only by a person on its confirmation page; there is no approve, decline or deny command.
  const spendRequests = program.command("spend-requests").description("requests for a higher limit; a person approves or declines each on its confirmation page");
  spendRequests
    .command("list")
    .description("list the spend requests waiting for you, and your own")
    .action(async (_options: unknown, command: Command) => printResult(command, await spendRequestsList(developerSession(), developerEnv(command))));
  spendRequests
    .command("open")
    .description("open a spend request's confirmation page in your browser, where you approve or decline it")
    .argument("<spend-request-id>", "the request's ID, from agentx spend-requests list")
    .option("--no-browser", "print the link instead of opening a browser")
    .action(async (spendRequestId: string, options: { browser: boolean }, command: Command) => {
      const link = await spendRequestConfirmLink(developerSession(), developerEnv(command), spendRequestId);
      printResult(command, link);
      if (options.browser && link.openUrl !== undefined) await (dependencies.login?.openBrowser ?? openSystemBrowser)(link.openUrl).catch(() => undefined);
    });

  // A task that stopped at a limit: a test run goes on as a normal task, and a plan whose run limit was denied or ran out asks again. Neither decides anything.
  const taskCommand = program.command("task").description("a task that stopped at a limit");
  taskCommand
    .command("continue-as-task")
    .description("a test run that reached its cap goes on as a normal task of yours")
    .argument("<task-id>", "the task's ID")
    .action(async (taskId: string, _options: unknown, command: Command) => printResult(command, await taskContinueAsTask(developerSession(), developerEnv(command), taskId)));
  taskCommand
    .command("ask-run-limit")
    .description("ask again for a plan's run limit after the last request was denied or ran out; a person approves it on its page")
    .argument("<task-id>", "the task's ID")
    .action(async (taskId: string, _options: unknown, command: Command) => printResult(command, await taskAskRunLimit(developerSession(), developerEnv(command), taskId)));

  org
    .command("spend")
    .description("what your organization has spent this month by project, member, agent, source and model (an org owner or admin); --ledger lists the settled lines")
    .option("--month <YYYY-MM>", "a month other than this one")
    .option("--ledger", "list the month's settled lines, newest first", false)
    .option("--cursor <cursor>", "with --ledger: the next page, from the cursor the last page printed")
    .action(async (options: { month?: string; ledger: boolean; cursor?: string }, command: Command) => printResult(command, await orgSpend(developerSession(), developerEnv(command), options)));
  const guardrails = org.command("guardrails").description("your company's agent guardrails");
  guardrails
    .command("show")
    .description("print the guardrails and their revision")
    .action(async (_options: unknown, command: Command) => printResult(command, await guardrailsShow(developerSession(), developerEnv(command))));
  guardrails
    .command("set")
    .description("replace the guardrails from a JSON file (an org owner or admin); a less safe change waits on the confirmation page")
    .option("--file <guardrails.json>", "the guardrails, as JSON")
    .action(async (options: { file?: string }, command: Command) => printResult(command, await guardrailsSet(developerSession(), developerEnv(command), options.file)));
  const sources = org.command("sources").description("your company's AI sources: where agents' models come from");
  sources
    .command("list")
    .description("list the sources, whether each holds a key, and the order they are tried in")
    .action(async (_options: unknown, command: Command) => printResult(command, await sourcesList(developerSession(), developerEnv(command))));
  sources
    .command("add")
    .description("add a source from a JSON file (an org owner or admin); its key is read only from an environment variable, for example one asm-exec sets")
    .option("--file <source.json>", "the source, as JSON")
    .option("--key-from-env <VAR>", "the environment variable holding the provider key")
    // Refused when given: a key is never a flag value.
    .addOption(new Option("--key <value>").hideHelp())
    .action(async (options: { file?: string; keyFromEnv?: string; key?: string }, command: Command) =>
      printResult(command, await sourcesAdd(developerSession(), developerEnv(command), options, dependencies.processEnv ?? process.env)));
  sources
    .command("remove")
    .description("remove a source (an org owner or admin)")
    .argument("<source-id>", "the source's ID")
    .action(async (sourceId: string, _options: unknown, command: Command) => printResult(command, await sourcesRemove(developerSession(), developerEnv(command), sourceId)));
  sources
    .command("order")
    .description("set the order sources are tried in (an org owner or admin)")
    .argument("<source-ids...>", "the sources, first to last")
    .action(async (order: string[], _options: unknown, command: Command) => printResult(command, await sourcesOrder(developerSession(), developerEnv(command), order)));
  sources
    .command("check")
    .description("test a source with its saved key (an org owner or admin)")
    .argument("<source-id>", "the source's ID")
    .action(async (sourceId: string, _options: unknown, command: Command) => printResult(command, await sourcesCheck(developerSession(), developerEnv(command), sourceId)));

  const githubCommand = program.command("github").description("the GitHub App of a Rovara Cloud install");
  githubCommand
    .command("oauth")
    .description("the GitHub App's OAuth client, which the per-organization install flow uses")
    .command("set")
    .description("store the GitHub App's client id and client secret on a Rovara Cloud install (operator role); prints what to change in the App's settings")
    .requiredOption("--client-id <id>", "the GitHub App's Client ID (General, About, Client ID)")
    .option("--client-secret-stdin", "read the client secret from standard input instead of asking for it", false)
    .option("--region <region>", "AWS region of the environment; defaults to your AWS configuration")
    .action(async (options: { clientId: string; clientSecretStdin: boolean; region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const overrides = dependencies.githubOauth ?? {};
      const awsConfig = options.region === undefined ? {} : { region: options.region };
      const result = await runGithubOauthSet({
        store: overrides.store ?? parameterStore(options.region),
        secrets: overrides.secrets ?? secretsManagerInitSecrets(new SecretsManagerClient(awsConfig)),
        github: overrides.github ?? githubRestApi(services.fetchImplementation),
        prompter: overrides.prompter ?? processPrompter(services.stderr),
        processEnv: overrides.processEnv ?? process.env,
        write: overrides.write ?? ((line) => { services.stderr.write(`${line}\n`); }),
        now: overrides.now ?? Date.now,
        readStdin: overrides.readStdin ?? (async () => { const chunks: Buffer[] = []; for await (const chunk of dependencies.stdin ?? process.stdin) chunks.push(Buffer.from(chunk as Uint8Array)); return Buffer.concat(chunks).toString("utf8"); }),
      }, globals.env, { clientId: options.clientId, clientSecretStdin: options.clientSecretStdin });
      services.stdout.write(globals.json ? formatSuccess(result, true) : `GitHub App client id and secret saved for ${result.env}.\n`);
    });

  githubCommand
    .command("connect")
    .description("connect your organization's GitHub account to Rovara (owners and admins, Rovara Cloud): opens GitHub's install page and waits until it is done")
    .option("--no-browser", "print the install link instead of opening a browser")
    .action(async (options: { browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const result = await githubConnect(developerSession(), developerEnv(command), {
        write: (line) => { services.stderr.write(`${line}\n`); },
        ...(options.browser ? { openBrowser: dependencies.login?.openBrowser ?? openSystemBrowser } : {}),
        ...(dependencies.githubConnect ?? {}),
      });
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, status: result.status, account: result.account, installationId: result.installationId }, true) : githubConnectText(result));
    });

  githubCommand
    .command("list")
    .description("the GitHub accounts connected to your organization, and any request still waiting for a GitHub admin")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await githubList(developerSession(), developerEnv(command));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, installations: result.installations, waiting: result.waiting }, true) : githubListText(result));
    });
  githubCommand
    .command("disconnect")
    .description("stop using a connected GitHub account (owners and admins). Its repositories stop working in Rovara; uninstall the app in GitHub's settings to remove its access there too")
    .argument("<account>", "the GitHub account's login, as agentx github list shows it")
    .action(async (account: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await githubDisconnect(developerSession(), developerEnv(command), account);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, installationId: result.installationId, accountLogin: result.accountLogin, message: result.message }, true) : githubDisconnectText(result));
    });

  registerSsoCommands(program, { ...(dependencies.sso === undefined ? {} : { overrides: dependencies.sso }), parameterStore, stdout: services.stdout, stderr: services.stderr });
  registerSigninCommands(program, {
    ...(dependencies.signin === undefined ? {} : { overrides: dependencies.signin }),
    parameterStore, fetch: services.fetchImplementation, stdout: services.stdout, stderr: services.stderr,
  });
  // Plan 2, Task 8: a person removes a sign-in method they did not add, or no longer wants, with their own sign-in (the other `signin`
  // commands are the operator's).
  const signinCommand = program.commands.find((candidate) => candidate.name() === "signin");
  if (signinCommand === undefined) throw new Error("the signin command is registered by registerSigninCommands");
  signinCommand
    .command("unlink")
    .description("remove a sign-in method (cloud or github) from your own Rovara account; sessions signed in that way end. Needs a sign-in from the last 10 minutes with another method")
    .argument("<method>", "cloud or github")
    .option("--no-browser", "if a fresh sign-in is needed, print the sign-in link instead of opening a browser")
    .action(async (method: string, options: { browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const result = await unlinkSignInMethod(developerSession(), developerEnv(command), method, freshSignInFor(command, options.browser));
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, removed: result.provider, identities: result.identities }, true) : unlinkText(result));
    });
  signinCommand
    .command("link")
    .description("add a sign-in method (cloud or github) you removed earlier back to your own Rovara account. Needs a sign-in from the last 10 minutes")
    .argument("<method>", "cloud or github")
    .option("--no-browser", "print the sign-in link instead of opening a browser")
    .action(async (method: string, options: { browser: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const result = await linkSignInMethod(developerSession(), developerEnv(command), method, freshSignInFor(command, options.browser));
      if (globals.json) {
        services.stdout.write(formatSuccess({ env: result.env, url: result.url, provider: result.provider, authorizeUrl: result.authorizeUrl }, true));
        return;
      }
      services.stdout.write(linkText(result, options.browser));
      if (options.browser) await (dependencies.login?.openBrowser ?? openSystemBrowser)(result.authorizeUrl).catch(() => undefined);
    });
  registerConfigCommands(program, {
    ...(dependencies.config === undefined ? {} : { overrides: dependencies.config }), parameterStore, fetch: services.fetchImplementation, stdout: services.stdout, stderr: services.stderr,
    stdin: dependencies.stdin ?? process.stdin,
    // Spec 025 FR-053: the workspace limits change with the admin sign-in of the environment --env names.
    adminSession: async (env: string) => {
      const session = await adminSessionFor(env);
      return session === undefined ? undefined : { controlPlaneUrl: session.baseUrl, accessToken: session.accessToken, expiresAt: session.expiresAt };
    },
  });

  registerLoopCommands(program, {
    home, version: CLI_VERSION, stdout: services.stdout, stderr: services.stderr,
    publicationJoin: createDeveloperPublicationJoinTransport({ home, env: () => globalOptions(program).env, tokenStore: services.tokenStore, fetch: services.fetchImplementation }),
    ...(dependencies.loop?.exec === undefined ? {} : { exec: dependencies.loop.exec }),
    ...(dependencies.loop?.cliCommand === undefined ? {} : { cliCommand: dependencies.loop.cliCommand }),
  });
  registerDoctorCommand(program, {
    ...(dependencies.doctor?.store === undefined ? {} : { store: dependencies.doctor.store }),
    ...(dependencies.doctor?.services === undefined ? {} : { services: dependencies.doctor.services }),
    parameterStore, fetch: services.fetchImplementation, home, stdout: services.stdout, stderr: services.stderr,
    adminSession: async (env: string) => {
      const session = await adminSessionFor(env);
      return session === undefined ? undefined : { controlPlaneUrl: session.baseUrl, accessToken: session.accessToken };
    },
  });
  registerUpgradeCommand(program, {
    ...(dependencies.upgrade === undefined ? {} : { overrides: dependencies.upgrade }),
    ...(dependencies.deploy === undefined ? {} : { deploy: dependencies.deploy }),
    parameterStore, fetch: services.fetchImplementation, home, stdout: services.stdout, stderr: services.stderr,
  });
  registerDestroyCommand(program, {
    ...(dependencies.destroy === undefined ? {} : { overrides: dependencies.destroy }),
    parameterStore, stdin: dependencies.stdin ?? process.stdin, home, tokenStore: services.tokenStore, stdout: services.stdout, stderr: services.stderr,
  });

  const admin = program.command("admin").description("administrator workflows");
  const adminProject = admin.command("project").description("administer registered projects");
  adminProject
    .command("register")
    .description("register an immutable project revision and trusted runtime binding")
    .requiredOption("--file <path>", "project YAML file")
    .option("--deployment-mode <mode>", "ec2-ebs", "ec2-ebs")
    .option("--launch-template-id <id>", "EC2 worker launch template (ec2-ebs), the foundation's Ec2WorkerLaunchTemplateId")
    .option("--subnets <pairs>", "availabilityZone=subnetId pairs, comma-separated (ec2-ebs), the foundation's Ec2WorkerSubnets")
    .option("--volume-size-gib <size>", "workspace volume size in GiB (ec2-ebs)", "20")
    .option("--volume-type <type>", "workspace volume type (ec2-ebs)", "gp3")
    .option("--take-ownership", "register a revision of an existing project you do not administer, becoming its administrator; needs --ownership-reason and is recorded")
    .option("--ownership-reason <why>", "why you are taking the project over (with --take-ownership); recorded with your identity and the time")
    .option("--region <region>", "AWS region of the environment, to read its settings for the project models' check; defaults to your AWS configuration")
    .action(async (options: {
      region?: string;
      file: string;
      deploymentMode: string;
      launchTemplateId?: string;
      subnets?: string;
      volumeSizeGib: string;
      volumeType: string;
      takeOwnership?: boolean;
      ownershipReason?: string;
    }, command: Command) => {
      const globals = globalOptions(command);
      if (options.takeOwnership === true && (options.ownershipReason === undefined || options.ownershipReason.trim() === "")) {
        throw agentXError("CONFIG_INVALID", "--take-ownership needs --ownership-reason <why>; the takeover is recorded with who took the project over, when, and why");
      }
      if (options.takeOwnership !== true && options.ownershipReason !== undefined) {
        throw agentXError("CONFIG_INVALID", "--ownership-reason only goes with --take-ownership; add it only if you mean to take the project over");
      }
      const deploymentMode = WorkspaceDeploymentModeSchema.parse(options.deploymentMode);
      const runtimeBinding = cliRuntimeBinding(deploymentMode, options);
      const parsedDefinition = await projectFromFile(options.file, globals.allowLoopback);
      // MODEL1: the project's models are checked here too; a failing default refuses, anything else warns.
      const modelChecked = await checkModelsForRegistration({
        definition: parsedDefinition, env: globals.env, store: parameterStore(options.region),
        checker: (environment) => dependencies.registerModelCheck ?? projectModelChecker(environment, { parameterStore, fetch: services.fetchImplementation, stderr: services.stderr }),
        acceptUncheckedModel: globals.acceptUncheckedModel,
      });
      const definition = modelChecked.definition;
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await registerProject({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        definition,
        runtimeBinding,
        ...(options.takeOwnership === true ? { takeOwnership: { reason: options.ownershipReason! } } : {}),
      }, services.fetchImplementation);
      if ((result as { ownershipTakenOver?: unknown } | undefined)?.ownershipTakenOver === true) {
        services.stderr.write(`Warning: you took over project ${definition.name}: you are now one of its administrators, and the takeover is recorded with your identity, the time and your reason.\n`);
      }
      try {
        const enrollment = await recordRegisteredLoopEnrollment({
          home, env: globals.env, controlPlaneUrl: settings.controlPlaneUrl, definition, response: result,
          ...(dependencies.loop?.exec === undefined ? {} : { exec: dependencies.loop.exec }),
        });
        if (!enrollment.recorded) services.stderr.write(`Warning: native project registration succeeded, but local Rovara enrollment is on hold (${enrollment.reasonCode}); register it from its source checkout or reconnect there before publication.\n`);
      } catch (error) {
        services.stderr.write(`Warning: native project registration succeeded, but local Rovara enrollment could not be saved (${(error as Error).message}); publication will remain on hold.\n`);
      }
      services.stdout.write(formatSuccess(result, globals.json));
      for (const warning of [...modelChecked.warnings, ...registrationWarnings(result, definition)]) services.stderr.write(`Warning: ${warning}\n`);
    });

  const runtimeInstallation = admin.command("runtime-installation").description("qualify and register the standard portable runtime");
  runtimeInstallation.command("challenge")
    .description("issue a one-use installation challenge for an explicitly identified private verifier host")
    .requiredOption("--binding-file <path>", "JSON EC2 runtime binding for the dedicated verifier host")
    .requiredOption("--endpoint <url>", "private IPv4 HTTP endpoint recorded for this host")
    .requiredOption("--generation <number>", "current worker generation")
    .requiredOption("--transport-correlation-id <uuid>", "current trusted worker/session correlation UUID")
    .requiredOption("--profile <id>", "fixed runtime profile: linux-arm64-docker-v1, linux-arm64-web-api-v1 or darwin-arm64-colima-v1")
    .requiredOption("--out <path>", "new private file receiving the challenge, including its one-use secret")
    .action(async (options: { bindingFile: string; endpoint: string; generation: string; transportCorrelationId: string; profile: string; out: string }, command: Command) => {
      const globals = globalOptions(command);
      const session = await adminSessionFor(globals.env);
      if (!session) throw agentXError("AUTH_REQUIRED", "an unexpired administrator session is required; sign in explicitly with `agentx login --admin`");
      const settings = await deploymentSettings(globals);
      const profileId = options.profile as "linux-arm64-docker-v1" | "darwin-arm64-colima-v1" | "linux-arm64-web-api-v1";
      const result = await requestRuntimeInstallChallenge({
        controlPlaneUrl: settings.controlPlaneUrl, accessToken: session.accessToken, bindingFile: options.bindingFile,
        endpoint: options.endpoint, generation: Number(options.generation), transportCorrelationId: options.transportCorrelationId,
        profileId, outputFile: options.out,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  runtimeInstallation.command("register")
    .description("approve the exact challenge-bound proof and atomically register both existing runtime catalogs")
    .requiredOption("--proposal-file <path>", "strict qualification proposal produced on the dedicated verifier host")
    .action(async (options: { proposalFile: string }, command: Command) => {
      const globals = globalOptions(command);
      const session = await adminSessionFor(globals.env);
      if (!session) throw agentXError("AUTH_REQUIRED", "an unexpired administrator session is required; sign in explicitly with `agentx login --admin`");
      const settings = await deploymentSettings(globals);
      const result = await submitRuntimeInstallProposal({ controlPlaneUrl: settings.controlPlaneUrl, accessToken: session.accessToken, proposalFile: options.proposalFile }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  /** The question before an invite's browser opens: (Y/n), so a plain Enter joins. It needs a terminal, or --yes. */
  const inviteConfirmer = (): ((question: string) => Promise<boolean>) => {
    if (dependencies.confirm !== undefined) return (question) => dependencies.confirm!(question);
    const stdin: NodeJS.ReadableStream & { isTTY?: boolean } = dependencies.stdin ?? process.stdin;
    if (stdin.isTTY !== true) throw agentXError("CONFIRMATION_UNAVAILABLE", "this needs a yes before the browser opens: run the command in a terminal to answer, or pass --yes; nothing changed");
    const output = new NodeWritable({ write(chunk: Buffer | string, _encoding, done) { services.stderr.write(chunk.toString()); done(); } });
    return (question) => askYesByDefault(question, { input: stdin, output, signals: process });
  };

  // Spec 025 E17 (Q6): a person typing the command is the confirmation; --yes answers for them.
  // Without --yes the prompt needs a terminal, checked before anything is planned.
  // Final review M11: as config set limits.* does, the prompt reads the command's own stdin and
  // writes through its own stderr, and no terminal is CONFIRMATION_UNAVAILABLE.
  const changeConfirmer = (yes: boolean): ((question: string) => Promise<boolean>) => {
    if (yes) return async () => true;
    if (dependencies.confirm !== undefined) return (question) => dependencies.confirm!(question);
    const stdin: NodeJS.ReadableStream & { isTTY?: boolean } = dependencies.stdin ?? process.stdin;
    if (stdin.isTTY !== true) throw agentXError("CONFIRMATION_UNAVAILABLE", "this change needs a yes: run the command in a terminal to answer its prompt, or pass --yes; nothing changed");
    const output = new NodeWritable({ write(chunk: Buffer | string, _encoding, done) { services.stderr.write(chunk.toString()); done(); } });
    return (question) => askToApply(question, { input: stdin, output, signals: process });
  };
  for (const action of ["grant", "revoke"] as const) {
    adminProject
      .command(action)
      .description(action === "grant"
        ? "let a developer hand tasks to a project from an AI tool: shows the change and asks first"
        : "remove a developer's granted access to a project: shows the change and asks first")
      .option("--project <name>", "the project's name (required)")
      .option("--developer <who>", "a Slack user ID such as U0123456789, the email they signed in with, or a developer ID (required)")
      .option("--yes", "apply without asking; the change is still printed", false)
      .action(async (options: { project?: string; developer?: string; yes: boolean }, command: Command) => {
        // Checked here, not by commander, so the refusal is AgentX's own and names what to do.
        // The program's own --project can take the value first, as it does for admin slack bind.
        const globals = globalOptions(command);
        // The global --project takes the value when given (as for admin slack bind), so read both.
        const projectName = options.project ?? globals.project;
        if (projectName === undefined) throw agentXError("CONFIG_INVALID", `--project is required: name the project, such as agentx admin project ${action} --project payments --developer U0123456789`);
        const project = AgentXNameSchema.safeParse(projectName);
        if (!project.success) throw agentXError("CONFIG_INVALID", "--project must be a project name: a lowercase letter, then up to 62 lowercase letters, digits or hyphens");
        // The developer reference is never echoed: it may be an email.
        const developer = options.developer?.trim();
        if (developer === undefined || developer === "") {
          throw agentXError("CONFIG_INVALID", "--developer is required: a Slack user ID such as U0123456789, the email they signed in to AgentX with, or a developer ID");
        }
        if (developer.length > 254) {
          throw agentXError("CONFIG_INVALID", "--developer must be at most 254 characters; name them by Slack user ID, the email they signed in with, or developer ID");
        }
        const confirm = changeConfirmer(options.yes);
        const { settings, accessToken } = await authenticate(globals, services.tokenStore);
        const result = await runCliChange({
          controlPlaneUrl: settings.controlPlaneUrl,
          accessToken,
          cliVersion: CLI_VERSION,
          change: { kind: action === "grant" ? "grant_project_access" : "revoke_project_access", project: project.data, developer },
          // The effect is already printed above the prompt.
          confirm: () => confirm("Apply this change?"),
          write: (line) => { services.stderr.write(`${line}\n`); },
        }, services.fetchImplementation);
        services.stdout.write(formatSuccess({ outcome: result.outcome, changeId: result.change.changeId }, globals.json));
      });
  }

  const adminWorkspace = admin.command("workspace").description("administer AgentX workspaces");
  adminWorkspace
    .command("list")
    .description("list workspaces with their Slack or developer owner identity and available name")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await listAdminWorkspaces({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminWorkspace
    .command("cancel")
    .description("cancel the workspace's running coding task; its conversation keeps what finished before")
    .requiredOption("--workspace <workspace-id>", "workspace whose task to cancel")
    .action(async (options: { workspace: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await cancelWorkspaceTask({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        workspaceId: options.workspace,
      }, services.fetchImplementation);
      // Issue 196: a task that had already finished keeps its result; say so plainly.
      const finished = (result as { finishedStatus?: unknown } | null)?.finishedStatus;
      const plain = finished === "CANCELLED" ? "The task was already cancelled."
        : typeof finished === "string" ? `The task had already finished as ${finished}, so nothing was cancelled.` : result;
      services.stdout.write(formatSuccess(globals.json ? result : plain, globals.json));
    });
  adminWorkspace
    .command("stop")
    .description("stop idle compute while retaining workspace storage")
    .requiredOption("--workspace <workspace-id>", "workspace to stop")
    .action(async (options: { workspace: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await stopWorkspace({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        workspaceId: options.workspace,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const adminBudget = admin.command("budget").description("monthly AI budget of a private or single-org install's organization (it has no limit until you set one)");
  adminBudget
    .command("set")
    .description("set the organization's monthly limit and the default monthly limit of each member, in US dollars")
    .option("--org-monthly <usd>", "the organization's monthly AI limit in US dollars")
    .option("--member-default <usd>", "each member's monthly AI limit in US dollars, unless they have their own")
    .action(async (options: { orgMonthly?: string; memberDefault?: string }, command: Command) => {
      const globals = globalOptions(command);
      const orgMonthlyUsd = options.orgMonthly === undefined ? undefined : parseBudgetUsd("--org-monthly", options.orgMonthly);
      const memberDefaultMonthlyUsd = options.memberDefault === undefined ? undefined : parseBudgetUsd("--member-default", options.memberDefault);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await setOrgBudget({
        controlPlaneUrl: settings.controlPlaneUrl, accessToken,
        ...(orgMonthlyUsd === undefined ? {} : { orgMonthlyUsd }), ...(memberDefaultMonthlyUsd === undefined ? {} : { memberDefaultMonthlyUsd }),
      }, services.fetchImplementation);
      services.stdout.write(globals.json ? formatSuccess(result, true) : budgetText(result.budget));
    });

  const adminEgress = admin.command("egress").description("domains projects ask to reach; on Rovara Cloud a new one is served only after Rovara staff approve it");
  adminEgress
    .command("pending")
    .description("list the domains waiting for approval, from every organization (Rovara Cloud operators only)")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await listPendingEgress({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetchImplementation);
      services.stdout.write(globals.json ? formatSuccess(result, true) : pendingText(result));
    });
  adminEgress
    .command("approve")
    .description("approve a pending domain: it joins the DNS allowlist of the cell")
    .argument("<org>", "the organization's ID")
    .argument("<owner>", "project:<name> or model-source:<id>, as `agentx admin egress pending` prints it")
    .argument("<domain>", "the domain")
    .action(async (org: string, owner: string, domain: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const parsedOwner = parseOwnerArgument(owner);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await decideEgress({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, decision: "approve", orgId: org, owner: parsedOwner, domain }, services.fetchImplementation);
      services.stdout.write(globals.json ? formatSuccess(result, true) : decisionText(result));
    });
  adminEgress
    .command("reject")
    .description("reject a pending domain; the project's maintainers are told why")
    .argument("<org>", "the organization's ID")
    .argument("<owner>", "project:<name> or model-source:<id>, as `agentx admin egress pending` prints it")
    .argument("<domain>", "the domain")
    .option("--reason <text>", "why, 1 to 200 characters; shown to the project's maintainers")
    .action(async (org: string, owner: string, domain: string, options: { reason?: string }, command: Command) => {
      const globals = globalOptions(command);
      const parsedOwner = parseOwnerArgument(owner);
      if (options.reason === undefined || options.reason.trim() === "") throw agentXError("CONFIG_INVALID", "say why with --reason <text>");
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await decideEgress({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, decision: "reject", orgId: org, owner: parsedOwner, domain, reason: options.reason }, services.fetchImplementation);
      services.stdout.write(globals.json ? formatSuccess(result, true) : decisionText(result));
    });

  // Release 0.4.17: an org owner or admin binds their own project to a Slack channel with the developer sign-in (the admin form above needs the operator's).
  const slack = program.command("slack").description("bind your project to a Slack channel with your own sign-in (an organization owner or admin)");
  slack
    .command("bind")
    .description("bind a Slack channel of your organization's Slack workspace to --project; then invite the bot in Slack")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .option("--team <team-id>", "Slack workspace ID, only when your organization has more than one")
    .action(async (options: { channel: string; team?: string }, command: Command) => {
      const globals = globalOptions(command);
      const project = AgentXNameSchema.parse(requireProject(globals));
      const result = await projectSlackBind(developerSession(), developerEnv(command), project, options.channel, options.team);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project, teamId: result.teamId, channelId: result.channelId, changed: result.changed }, true) : slackBindText(result));
    });
  slack
    .command("unbind")
    .description("remove a Slack channel binding from --project; existing thread workspaces are kept")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .option("--team <team-id>", "Slack workspace ID, only when your organization has more than one")
    .action(async (options: { channel: string; team?: string }, command: Command) => {
      const globals = globalOptions(command);
      const project = AgentXNameSchema.parse(requireProject(globals));
      const result = await projectSlackUnbind(developerSession(), developerEnv(command), project, options.channel, options.team);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project, teamId: result.teamId, channelId: result.channelId, removed: result.changed }, true) : slackUnbindText(result));
    });

  const adminSlack = admin.command("slack").description("bind Slack channels to this project for the hosted orchestrator");
  adminSlack
    .command("bind")
    .description("bind a Slack channel to this project; new threads use its latest registered revision")
    .requiredOption("--team <team-id>", "Slack team ID, for example T0123456789")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await bindSlackChannel({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        teamId: options.team,
        channelId: options.channel,
        projectName: AgentXNameSchema.parse(requireProject(globals)),
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminSlack
    .command("connect-team")
    .description("connect a Slack workspace to an organization, so its owner can bind channels with their own sign-in (Rovara operators)")
    .requiredOption("--org <org-id>", "the organization's ID, for example org_abcdefghijklmnopqrst")
    .requiredOption("--team <team-id>", "Slack workspace ID, for example T0123456789")
    .action(async (options: { org: string; team: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await connectSlackTeam({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, teamId: options.team, orgId: options.org }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminSlack
    .command("disconnect-team")
    .description("release a Slack workspace from the organization that holds it (Rovara operators); refused while that organization still has channels bound in it")
    .requiredOption("--team <team-id>", "Slack workspace ID, for example T0123456789")
    .action(async (options: { team: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await disconnectSlackTeam({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, teamId: options.team }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminSlack
    .command("unbind")
    .description("remove a Slack channel binding; existing thread workspaces are kept")
    .requiredOption("--team <team-id>", "Slack team ID")
    .requiredOption("--channel <channel-id>", "Slack channel ID")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await unbindSlackChannel({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        teamId: options.team,
        channelId: options.channel,
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  const adminEval = admin.command("eval").description("SWE-bench runs from Slack (spec 043): `@agentx eval swebench <dataset> <instance>` in an enabled channel");
  const evalChannel = (options: { team: string; channel: string }, settings: { controlPlaneUrl: string }, accessToken: string) => ({
    controlPlaneUrl: settings.controlPlaneUrl, accessToken, teamId: options.team, channelId: options.channel,
  });
  adminEval
    .command("enable")
    .description("let any member of a bound channel start SWE-bench runs, each capped at a cost ceiling")
    .requiredOption("--team <team-id>", "Slack team ID, for example T0123456789")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .option("--max-cost-usd <usd>", "per-run cost ceiling in US dollars, from 1 to 100 (default 10)", parseMaxCostUsd)
    .action(async (options: { team: string; channel: string; maxCostUsd?: number }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await enableEvalChannel({
        ...evalChannel(options, settings, accessToken),
        ...(options.maxCostUsd === undefined ? {} : { maxCostUsd: options.maxCostUsd }),
      }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminEval
    .command("show")
    .description("show whether a channel may start SWE-bench runs, and its cost ceiling")
    .requiredOption("--team <team-id>", "Slack team ID")
    .requiredOption("--channel <channel-id>", "Slack channel ID")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await showEvalChannel(evalChannel(options, settings, accessToken), services.fetchImplementation), globals.json));
    });
  adminEval
    .command("disable")
    .description("stop a channel from starting SWE-bench runs; a run in progress finishes")
    .requiredOption("--team <team-id>", "Slack team ID")
    .requiredOption("--channel <channel-id>", "Slack channel ID")
    .action(async (options: { team: string; channel: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await disableEvalChannel(evalChannel(options, settings, accessToken), services.fetchImplementation), globals.json));
    });

  const adminEvalBatch = adminEval.command("batch").description("batches of eval runs from a file (spec 052): start, show, stop, results");
  const batchOutput = (globals: { json: boolean }, result: unknown, text: string) => formatSuccess(globals.json ? result : text, globals.json);
  adminEvalBatch
    .command("start")
    .description("start a batch from a YAML file in a bound, eval-enabled channel; prints its batch ID")
    .requiredOption("--file <path>", "the batch file: benchmark, tasks, models, repeats, order, concurrency, costCapUsd (docs/swebench-eval.md)")
    .requiredOption("--team <team-id>", "Slack team ID, for example T0123456789")
    .requiredOption("--channel <channel-id>", "Slack channel ID, for example C0123456789")
    .option("--label <text>", "start another batch from a file that has already been run in this channel (the same file starts the same batch)")
    .action(async (options: { file: string; team: string; channel: string; label?: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await startEvalBatch({
        controlPlaneUrl: settings.controlPlaneUrl, accessToken, teamId: options.team, channelId: options.channel, filePath: options.file,
        ...(options.label === undefined ? {} : { label: options.label }),
      }, services.fetchImplementation);
      services.stdout.write(batchOutput(globals, result, evalBatchStartText(result)));
    });
  adminEvalBatch
    .command("show")
    .description("show a batch's progress, spend and final status")
    .argument("<batch-id>", "the batch ID")
    .action(async (batchId: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await showEvalBatch({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, batchId }, services.fetchImplementation);
      services.stdout.write(batchOutput(globals, result, evalBatchShowText(result)));
    });
  adminEvalBatch
    .command("stop")
    .description("stop a batch: queued runs are cancelled and runs in flight are stopped; an ended batch reports its final status")
    .argument("<batch-id>", "the batch ID")
    .action(async (batchId: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await stopEvalBatch({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, batchId }, services.fetchImplementation);
      services.stdout.write(batchOutput(globals, result, evalBatchShowText(result)));
    });
  adminEvalBatch
    .command("results")
    .description("a batch's results, read through the control plane: the per-model table, or the per-run CSV with --csv")
    .argument("<batch-id>", "the batch ID")
    .option("--csv <path>", "write the per-run results.csv here instead of printing the table")
    .action(async (batchId: string, options: { csv?: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await fetchEvalBatchResults({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, batchId }, services.fetchImplementation);
      const text = await batchResultsOutput(result, options.csv);
      services.stdout.write(batchOutput(globals, globals.json && options.csv !== undefined ? { ...(result as object), csv: undefined, csvPath: options.csv } : result, text));
    });

  const adminCredential = admin.command("credential").description("register connector credentials stored in Secrets Manager under agentx/connectors/ or agentx/<env>/connectors/");
  adminCredential
    .command("register")
    .description("register or replace a credential reference; the secret must already exist")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--type <type>", "static-secret, oauth-client-credentials or oauth-refresh-token")
    .requiredOption("--secret <name>", "Secrets Manager secret name, agentx/connectors/<name> or agentx/<env>/connectors/<name>")
    .option("--host <host>", "the one MCP host this credential may be sent to, such as mcp.sentry.dev; required by a generic mcp connector")
    .option("--token-url <url>", "an OAuth credential's token endpoint, for a generic mcp connector")
    .option("--resource <url>", "the RFC 8707 resource an OAuth credential's tokens are for, for a generic mcp connector")
    .action(async (options: { ref: string; type: string; secret: string; host?: string; tokenUrl?: string; resource?: string }, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await registerCredential({
        controlPlaneUrl: settings.controlPlaneUrl, accessToken, ref: options.ref, type: options.type, secretName: options.secret,
        ...(options.host === undefined ? {} : { host: options.host }),
        ...(options.tokenUrl === undefined ? {} : { tokenUrl: options.tokenUrl }),
        ...(options.resource === undefined ? {} : { resource: options.resource }),
      }, services.fetchImplementation), globals.json));
    });
  adminCredential
    .command("authorize")
    .description("sign the connector's bot user in once in a browser, store its refresh token in the secret, and register it as oauth-refresh-token")
    .requiredOption("--ref <reference>", "credential reference used by connectors' credentialRef")
    .requiredOption("--secret <name>", "Secrets Manager secret holding the app's {\"clientId\", \"clientSecret\"}, agentx/connectors/<name> or agentx/<env>/connectors/<name>")
    .option("--provider <name>", "a built-in sign-in page: asana")
    .option("--endpoint <url>", "a generic MCP server's endpoint: discover its sign-in, and register the credential pinned to its host")
    .option("--authorize-url <url>", "with --endpoint: the authorization endpoint, when the server does not publish OAuth metadata")
    .option("--token-url <url>", "with --endpoint: the token endpoint, when the server does not publish OAuth metadata")
    .option("--scope <scopes>", "space-separated scopes to ask for; defaults to what the server asks for")
    .option("--register-client", "with --endpoint: register AgentX as the server's OAuth client instead of reading one from the secret")
    .option("--region <region>", "AWS region of the secret; defaults to your AWS configuration")
    .option("--no-browser", "do not open a browser; only print the sign-in URL, to open in a private window signed in as the bot user")
    .option("--expect-account <email>", "the bot user's email; refuse, storing nothing, when another account signs in")
    .action(async (options: {
      ref: string; secret: string; provider?: string; endpoint?: string; authorizeUrl?: string; tokenUrl?: string; scope?: string; registerClient?: boolean;
      region?: string; browser: boolean; expectAccount?: string;
    }, command: Command) => {
      const globals = globalOptions(command);
      // A blank --expect-account fails before logging in or reading the secret.
      expectedAccountEmail(options.expectAccount);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const overrides = dependencies.authorize ?? {};
      const result = await authorizeCredential({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        ref: options.ref,
        secretName: options.secret,
        ...(options.provider === undefined ? {} : { provider: options.provider }),
        ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
        ...(options.authorizeUrl === undefined ? {} : { authorizeUrl: options.authorizeUrl }),
        ...(options.tokenUrl === undefined ? {} : { tokenUrl: options.tokenUrl }),
        ...(options.scope === undefined ? {} : { scope: options.scope }),
        ...(options.registerClient === true ? { registerClient: true } : {}),
        secrets: overrides.secrets ?? secretsManagerAuthorizeSecrets(new SecretsManagerClient(options.region ? { region: options.region } : {})),
        ...(options.browser ? { openBrowser: overrides.openBrowser ?? openSystemBrowser } : {}),
        ...(options.expectAccount === undefined ? {} : { expectAccount: options.expectAccount }),
        showUrl: (url, redirectRequirement) => {
          const open = options.browser
            ? "If no browser opened, or it is signed in as someone else, open this URL in a private window signed in as the bot user"
            : "Open this URL in a private window signed in as the bot user";
          services.stderr.write(`Sign in as the connector's bot user ${redirectRequirement}. ${open}:\n${url}\n`);
        },
        showAccount: (line) => { services.stderr.write(`${line}\n`); },
        ...(options.region === undefined ? {} : { region: options.region }),
        fetchImplementation: services.fetchImplementation,
        ...(overrides.listenPort === undefined ? {} : { listenPort: overrides.listenPort }),
        ...(overrides.onListening ? { onListening: overrides.onListening } : {}),
      });
      services.stderr.write(`Stored the refresh token in ${options.secret} and registered ${options.ref} as oauth-refresh-token.\n`);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  adminCredential
    .command("list")
    .description("list credential references, types, secret names and whether a token is cached; never secret values")
    .action(async (_options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      services.stdout.write(formatSuccess(await listCredentials({ controlPlaneUrl: settings.controlPlaneUrl, accessToken }, services.fetchImplementation), globals.json));
    });

  const adminTurns = admin.command("turns").description("export turn records: what each Slack turn was offered, asked, chose and answered (kept 30 days)");
  adminTurns
    .command("export")
    .description("write turn records as JSON Lines, newest first; they hold request and response text, so keep the output private")
    .requiredOption("--since <duration>", "how far back to export, such as 30m, 12h or 7d (at most 30d)")
    .option("--output <file>", "write to this file with owner-only permissions instead of stdout")
    .action(async (options: { since: string; output?: string }, command: Command) => {
      const globals = globalOptions(command);
      const since = parseSince(options.since);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      if (options.output === undefined) {
        let printed = 0;
        let result: Awaited<ReturnType<typeof exportTurns>>;
        try {
          result = await exportTurns({
            controlPlaneUrl: settings.controlPlaneUrl,
            accessToken,
            since,
            write: (line) => {
              services.stdout.write(line);
              printed += 1;
            },
          }, services.fetchImplementation);
        } catch (error) {
          throw exportFailure(error, printed, "stdout");
        }
        // stdout carries only JSON Lines, so the summary goes to stderr.
        services.stderr.write(formatSuccess(result, globals.json));
        return;
      }
      // Write beside the target first, so a failure partway never leaves the target itself
      // half-written; only a completed export is ever renamed over it.
      const outputPath = resolve(options.output);
      const partialPath = `${outputPath}.partial`;
      const file = await open(partialPath, "w", 0o600);
      let written = 0;
      try {
        // open() applies the mode only to a new file; tighten an existing one too.
        await file.chmod(0o600);
        const result = await exportTurns({
          controlPlaneUrl: settings.controlPlaneUrl,
          accessToken,
          since,
          write: async (line) => {
            await file.write(line);
            written += 1;
          },
        }, services.fetchImplementation);
        await file.close();
        await rename(partialPath, outputPath);
        // stdout carries only JSON Lines, so the summary goes to stderr.
        services.stderr.write(formatSuccess(result, globals.json));
      } catch (error) {
        await file.close().catch(() => undefined);
        await rm(partialPath, { force: true });
        throw exportFailure(error, written, "file");
      }
    });

  const adminTask = admin.command("task").description("administer tasks started from AI tools");
  adminTask
    .command("share-mode")
    .description("switch a shared task between view only and continue, within its project's policy")
    .requiredOption("--task <task-id>", "the task to change")
    .requiredOption("--mode <mode>", "view or continue")
    .action(async (options: { task: string; mode: string }, command: Command) => {
      if (options.mode !== "view" && options.mode !== "continue") throw agentXError("CONFIG_INVALID", "--mode must be view or continue");
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(options.task)) {
        throw agentXError("CONFIG_INVALID", "--task must be a task ID, such as 44444444-4444-4444-8444-444444444444; agentx admin turns export shows task IDs");
      }
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await setTaskShareMode({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, taskId: options.task, mode: options.mode }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  // M1.4 Task 4.6b: the audit replay of a task's qualified AI-navigated round (no model; recorded apart from the task, which it never changes).
  const taskE2EReplay = adminTask.command("e2e-replay").description("replay a task's verified AI-navigated round with no model, for an audit; the result never changes the task");
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  taskE2EReplay.command("start")
    .description("start a replay of the task's qualified round (refused when it left no recording, is not PASS now, or one is already running)")
    .requiredOption("--task <task-id>", "the task")
    .requiredOption("--round <round-id>", "the task's qualified round")
    .action(async (options: { task: string; round: string }, command: Command) => {
      if (!uuidPattern.test(options.task) || !uuidPattern.test(options.round)) throw agentXError("CONFIG_INVALID", "--task and --round must be IDs, such as 44444444-4444-4444-8444-444444444444");
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await startTaskE2EReplay({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, taskId: options.task, roundId: options.round }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });
  taskE2EReplay.command("show")
    .description("read the record of each replay attempt of a task's round")
    .requiredOption("--task <task-id>", "the task")
    .option("--round <round-id>", "the round (default: the task's qualified round)")
    .action(async (options: { task: string; round?: string }, command: Command) => {
      if (!uuidPattern.test(options.task) || (options.round !== undefined && !uuidPattern.test(options.round))) throw agentXError("CONFIG_INVALID", "--task and --round must be IDs, such as 44444444-4444-4444-8444-444444444444");
      const globals = globalOptions(command);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await showTaskE2EReplays({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, taskId: options.task, ...(options.round === undefined ? {} : { roundId: options.round }) }, services.fetchImplementation);
      services.stdout.write(formatSuccess(result, globals.json));
    });

  // Spec 025 FR-052: registered after the existing admin commands, so their order is unchanged.
  admin
    .command("changes")
    .description("list admin change records (kept 30 days): who asked, the change, how it was confirmed and how it ended; --json writes JSON Lines")
    .requiredOption("--since <duration>", "how far back, such as 30m, 12h or 7d (at most 30d)")
    .action(async (options: { since: string }, command: Command) => {
      const globals = globalOptions(command);
      const since = parseSince(options.since, Date.now(), "change records");
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const result = await exportChanges({
        controlPlaneUrl: settings.controlPlaneUrl,
        accessToken,
        since,
        json: globals.json,
        write: (line) => { services.stdout.write(line); },
      }, services.fetchImplementation);
      // stdout carries only the records, so the count goes to stderr.
      services.stderr.write(`${result.exported} change record${result.exported === 1 ? "" : "s"} since ${result.since}\n`);
    });

  // Rovara staff read one organization's audit log (Task 14). The control plane records each read, with this reason, before it reads.
  const adminAudit = admin.command("audit").description("read an organization's audit log as Rovara staff; every read is recorded in that organization's log with your reason");
  adminAudit
    .command("log")
    .argument("<org>", "the organization's ID")
    .description("show an organization's audit log records")
    .option("--reason <text>", "why you are reading this log (1 to 300 characters); recorded in the organization's log")
    .option("--ticket <id>", "a ticket or case reference, such as SUP-42")
    .option("--from <record-or-time>", "start at this record number, or at this time, such as 2026-10-20T12:00:00Z")
    .option("--to <record-or-time>", "stop at this record number, or at this time")
    .option("--action <action>", "only records of this action")
    .option("--limit <count>", "how many records to show, 1 to 200 (50 by default)")
    .option("--cursor <cursor>", "continue after the last page, with the cursor it printed")
    .action(async (org: string, options: AuditLogFlags & { reason?: string; ticket?: string }, command: Command) => {
      const globals = globalOptions(command);
      const orgId = staffOrgId(org);
      const why = staffJustification(options.reason, options.ticket);
      auditLogQuery(options);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const records = await fetchStaffRecords({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, fetch: services.fetchImplementation }, orgId, why, options);
      services.stdout.write(globals.json ? formatSuccess(jsonSafe({ orgId, ...records }), true) : auditLogText(records));
    });
  adminAudit
    .command("export")
    .argument("<org>", "the organization's ID")
    .description("export a range of an organization's audit log to a file; polls the staff path no more often than every 10 seconds")
    .option("--reason <text>", "why you are reading this log (1 to 300 characters); recorded in the organization's log")
    .option("--ticket <id>", "a ticket or case reference, such as SUP-42")
    .option("--from <record>", "the first record number to export")
    .option("--to <record>", "the last record number to export (at most 200,000 records)")
    .option("--with-details", "include the names and other personal details", false)
    .option("--out <file>", "where to save the export; it is never written over an existing file")
    .action(async (org: string, options: { reason?: string; ticket?: string; from?: string; to?: string; withDetails: boolean; out?: string }, command: Command) => {
      const globals = globalOptions(command);
      const orgId = staffOrgId(org);
      const why = staffJustification(options.reason, options.ticket);
      const range = exportRange(options.from, options.to);
      if (options.out === undefined) throw agentXError("CONFIG_INVALID", "say where to save the export: --out <file>");
      const out = resolve(options.out);
      await assertNewFile(out);
      const { settings, accessToken } = await authenticate(globals, services.tokenStore);
      const transport = staffExportTransport({ controlPlaneUrl: settings.controlPlaneUrl, accessToken, fetch: services.fetchImplementation }, orgId, why);
      services.stdout.write(await exportAuditFile(transport, auditRuntime(), { ...range, withDetails: options.withDetails, out, json: globals.json }));
    });

  registerSetupCommands(program, dependencies.setup ?? realSetupContext({
    parameterStore, fetch: services.fetchImplementation, tokenStore: services.tokenStore, stdout: services.stdout, stderr: services.stderr, home,
  }));

  // Ruling R55: on Rovara Cloud an owner or admin creates the org's projects with their own sign-in (agentx project add is the
  // administrator's, for a private install).
  const projectCommand = program.commands.find((candidate) => candidate.name() === "project");
  if (projectCommand === undefined) throw new Error("the project command is registered by registerSetupCommands");
  // Plan 4 Task 19: the hooks vendors post a project's events to.
  const hooks = projectCommand.command("hooks").description("the addresses vendors post a project's events to: list, create, rotate a secret, delete");
  hooks
    .command("list")
    .description("list a project's event hooks")
    .argument("<project>", "the project")
    .action(async (project: string, _options: unknown, command: Command) => printResult(command, await hooksList(developerSession(), developerEnv(command), project)));
  hooks
    .command("create")
    .description("make a hook for a source; a vendor's secret is read from a file, and one Rovara makes is shown once")
    .argument("<project>", "the project")
    .option("--source <source>", "the vendor: linear, jira, pagerduty, sentry, datadog, grafana or vercel")
    .option("--tenant <tenant.json>", "what binds the hook to your account at the vendor, as JSON")
    .option("--secret-file <file>", "the signing secret the vendor gave you (for sources whose vendor makes it)")
    .action(async (project: string, options: { source?: string; tenant?: string; secretFile?: string }, command: Command) => printResult(command, await hooksCreate(developerSession(), developerEnv(command), project, {
      ...(options.source === undefined ? {} : { source: options.source }), ...(options.tenant === undefined ? {} : { tenantFile: options.tenant }), ...(options.secretFile === undefined ? {} : { secretFile: options.secretFile }),
    })));
  hooks
    .command("rotate")
    .description("change a hook's secret; the old one keeps working for 24 hours")
    .argument("<project>", "the project")
    .argument("<hook-id>", "the hook's ID, from the list")
    .option("--secret-file <file>", "the new secret the vendor gave you (for sources whose vendor makes it)")
    .action(async (project: string, hookId: string, options: { secretFile?: string }, command: Command) => printResult(command, await hooksRotate(developerSession(), developerEnv(command), project, hookId, options.secretFile === undefined ? {} : { secretFile: options.secretFile })));
  hooks
    .command("delete")
    .description("delete a hook: its address answers nothing and its secret is scheduled for deletion")
    .argument("<project>", "the project")
    .argument("<hook-id>", "the hook's ID, from the list")
    .action(async (project: string, hookId: string, _options: unknown, command: Command) => printResult(command, await hooksDelete(developerSession(), developerEnv(command), project, hookId)));
  const collect = (value: string, previous: string[]) => [...previous, value];
  projectCommand
    .command("create")
    .description("create a project from a GitHub repository, on Rovara Cloud (an owner or admin of your organization)")
    .option("--repository <owner/name>", "the GitHub repository, which your organization's GitHub connection must reach (agentx github connect)")
    .option("--name <name>", "the project's name (default: the repository's)")
    .option("--description <text>", "what the project is, up to 280 characters")
    .option("--setup-command <command>", "a setup command, or \"\" for none; give it again for each one, in order", collect, [] as string[])
    .option("--test-command <command>", "a test command, or \"\" for none; give it again for each one, in order", collect, [] as string[])
    .action(async (options: { repository?: string; name?: string; description?: string; setupCommand: string[]; testCommand: string[] }, command: Command) => {
      const globals = globalOptions(command);
      if (options.repository === undefined) throw agentXError("CONFIG_INVALID", "name the repository: --repository <owner/name>");
      const result = await createDeveloperProject(developerSession(), developerEnv(command), {
        requestId: randomUUID(),
        repository: options.repository,
        ...(options.name === undefined ? {} : { name: options.name }),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.setupCommand.length === 0 ? {} : { setupCommands: options.setupCommand }),
        ...(options.testCommand.length === 0 ? {} : { testCommands: options.testCommand }),
      });
      services.stdout.write(globals.json
        ? formatSuccess({ env: result.env, url: result.url, duplicate: result.created.duplicate, project: result.created.project.definition }, true)
        : createProjectText(result));
    });

  // Plan 2, Task 17: a project's settings, with the signed-in developer's own sign-in. A maintainer changes them; anyone with access reads them.
  projectCommand
    .command("show")
    .description("show a project's settings: commands, devcontainer, repositories and allowed domains, on Rovara Cloud")
    .argument("<name>", "the project's name")
    .action(async (name: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await showDeveloperProject(developerSession(), developerEnv(command), name);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project: result.project }, true) : projectShowText(result.project));
    });
  // Plan 2, Task 20: a maintainer archives a project (asking first) and restores it.
  projectCommand
    .command("archive")
    .description("archive a project (a maintainer of the project): no new tasks can start in it; running work keeps going. Asks first")
    .argument("<name>", "the project's name")
    .option("--yes", "archive without asking", false)
    .action(async (name: string, options: { yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      const confirm = changeConfirmer(options.yes);
      if (!await confirm(archiveProjectQuestion(name))) throw agentXError("CONFIRMATION_DECLINED", `you did not archive ${name}; nothing changed`);
      const result = await changeDeveloperProjectArchive(developerSession(), developerEnv(command), name, "archive", randomUUID());
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project: result.project, warnings: result.warnings }, true) : archiveProjectText(result));
    });
  projectCommand
    .command("restore")
    .description("restore an archived project (a maintainer of the project)")
    .argument("<name>", "the project's name")
    .action(async (name: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await changeDeveloperProjectArchive(developerSession(), developerEnv(command), name, "restore", randomUUID());
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project: result.project, warnings: result.warnings }, true) : restoreProjectText(result));
    });
  // Plan 6, Task 19 (the Task 25 slice): a project's code settings. A maintainer changes them; self-approval turned on waits for an organization owner or admin to confirm it in a browser.
  projectCommand
    .command("code-settings")
    .description("show or change how Rovara merges a project's pull requests: self-approval (on needs an organization owner or admin to confirm it in a browser), the merge method and the reviewers it asks")
    .argument("<project>", "the project's name")
    .option("--self-approval <on|off>", "let the person who asked for a pull request approve it (on waits for an organization owner or admin to confirm)")
    .option("--merge-method <squash|merge>", "how a pull request is merged")
    .option("--reviewers <names>", "GitHub names Rovara asks for a review, separated by commas (a person, or org/team), or none")
    .action(async (project: string, options: { selfApproval?: string; mergeMethod?: string; reviewers?: string }, command: Command) => printResult(command, await projectCodeSettings(developerSession(), developerEnv(command), project, options)));
  // Plan 2, Task 22: a maintainer has the project's setup and test commands run on a fresh workspace, and waits for the answer.
  projectCommand
    .command("check")
    .description("run a project's setup and test commands on a fresh workspace and wait for the result (a maintainer of the project); a failure exits non-zero and names the step")
    .argument("<name>", "the project's name")
    .action(async (name: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await checkDeveloperProject(developerSession(), developerEnv(command), name, { sleep: services.sleep });
      const text = projectCheckText(result.project);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project: result.project }, true) : text);
    });
  // Plan 2, Task 21: the people in a project and their roles. Anyone who can see the project lists them; a maintainer changes them.
  projectCommand
    .command("members")
    .description("list the people in a project: each person's role (maintainer, contributor or viewer) and who added them")
    .argument("<name>", "the project's name")
    .action(async (name: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await projectMembers(developerSession(), developerEnv(command), name);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, members: result.members }, true) : projectMembersText({ ...result, project: name }));
    });
  projectCommand
    .command("add-member")
    .description("give someone in your organization a role in a project, or change it (a maintainer of the project)")
    .argument("<name>", "the project's name")
    .argument("<email-or-id>", "the person's email or developer ID, from agentx org members")
    .addOption(new Option("--role <role>", "what they may do: maintainer (manage the project and its people), contributor (start tasks) or viewer (look only)").choices(["maintainer", "contributor", "viewer"]).makeOptionMandatory())
    .action(async (name: string, who: string, options: { role: ProjectRole }, command: Command) => {
      const globals = globalOptions(command);
      const result = await projectAddMember(developerSession(), developerEnv(command), name, who, options.role);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, member: { developerId: result.member.developerId, role: result.role } }, true) : projectAddMemberText(result));
    });
  projectCommand
    .command("remove-member")
    .description("take away someone's role in a project (a maintainer of the project); org owners and admins keep maintaining every project")
    .argument("<name>", "the project's name")
    .argument("<email-or-id>", "the person's email or developer ID, from agentx project members")
    .action(async (name: string, who: string, _options: unknown, command: Command) => {
      const globals = globalOptions(command);
      const result = await projectRemoveMember(developerSession(), developerEnv(command), name, who);
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, developerId: result.member.developerId, removed: result.removed }, true) : projectRemoveMemberText(result));
    });
  projectCommand
    .command("settings")
    .description("change a project's settings, on Rovara Cloud (a maintainer of the project); only the settings you give change")
    .argument("<name>", "the project's name")
    .option("--setup-command <command>", "a setup command; give it again for each one, in order (replaces the project's setup commands)", collect, [] as string[])
    .option("--clear-setup-commands", "remove every setup command")
    .option("--test-command <command>", "a test command; give it again for each one, in order (replaces the project's test commands)", collect, [] as string[])
    .option("--clear-test-commands", "remove every test command")
    .option("--allow-domain <domain>", "a website the project's machines may reach, such as artifacts.acme.dev or *.acme.dev; give it again for each (replaces the project's list)", collect, [] as string[])
    .option("--clear-allowed-domains", "remove every allowed domain")
    .option("--description <text>", "the project's description, or \"\" for none")
    .option("--add-repository <owner/name>", "add a repository of your connected GitHub account; give it again for each", collect, [] as string[])
    .option("--remove-repository <name>", "remove a repository, by its name or owner/name; give it again for each", collect, [] as string[])
    .option("--devcontainer-repository <name>", "the repository whose devcontainer the project's commands run in")
    .option("--devcontainer-config <path>", "the devcontainer's configuration file in that repository (default .devcontainer/devcontainer.json)")
    .option("--remove-devcontainer", "run the project's commands without a devcontainer")
    .action(async (name: string, options: {
      setupCommand: string[]; clearSetupCommands?: boolean; testCommand: string[]; clearTestCommands?: boolean; allowDomain: string[]; clearAllowedDomains?: boolean;
      description?: string; addRepository: string[]; removeRepository: string[]; devcontainerRepository?: string; devcontainerConfig?: string; removeDevcontainer?: boolean;
    }, command: Command) => {
      const globals = globalOptions(command);
      const conflicts: Array<[boolean, string]> = [
        [options.clearSetupCommands === true && options.setupCommand.length > 0, "--setup-command and --clear-setup-commands"],
        [options.clearTestCommands === true && options.testCommand.length > 0, "--test-command and --clear-test-commands"],
        [options.clearAllowedDomains === true && options.allowDomain.length > 0, "--allow-domain and --clear-allowed-domains"],
        [options.removeDevcontainer === true && (options.devcontainerRepository !== undefined || options.devcontainerConfig !== undefined), "--remove-devcontainer and the devcontainer options"],
      ];
      const conflict = conflicts.find(([clash]) => clash);
      if (conflict !== undefined) throw agentXError("CONFIG_INVALID", `choose one: ${conflict[1]} contradict each other`);
      if (options.devcontainerConfig !== undefined && options.devcontainerRepository === undefined) throw agentXError("CONFIG_INVALID", "--devcontainer-config needs --devcontainer-repository");
      const result = await changeDeveloperProjectSettings(developerSession(), developerEnv(command), name, {
        ...(options.clearSetupCommands === true ? { setupCommands: [] } : options.setupCommand.length > 0 ? { setupCommands: options.setupCommand } : {}),
        ...(options.clearTestCommands === true ? { testCommands: [] } : options.testCommand.length > 0 ? { testCommands: options.testCommand } : {}),
        ...(options.clearAllowedDomains === true ? { allowedDomains: [] } : options.allowDomain.length > 0 ? { allowedDomains: options.allowDomain } : {}),
        ...(options.description === undefined ? {} : { description: options.description }),
        ...(options.addRepository.length > 0 ? { addRepositories: options.addRepository } : {}),
        ...(options.removeRepository.length > 0 ? { removeRepositories: options.removeRepository } : {}),
        ...(options.removeDevcontainer === true ? { devcontainer: null }
          : options.devcontainerRepository === undefined ? {}
            : { devcontainer: { repository: options.devcontainerRepository, ...(options.devcontainerConfig === undefined ? {} : { configPath: options.devcontainerConfig }) } }),
      }, randomUUID());
      services.stdout.write(globals.json ? formatSuccess({ env: result.env, url: result.url, project: result.project, warnings: result.warnings }, true) : projectSettingsText(result));
    });

  // Plan 3, Task 35a: a project's agents, connectors and AI settings.
  const projectAgents = projectCommand.command("agents").description("the agents that work on a project");
  for (const add of [true, false]) {
    projectAgents
      .command(add ? "add" : "remove")
      .description(add ? "let an agent work on a project (a maintainer of the project)" : "stop an agent working on a project (a maintainer of the project)")
      .argument("<project>", "the project's name")
      .argument("<agent-id>", "the agent's ID")
      .action(async (project: string, agentId: string, _options: unknown, command: Command) => printResult(command, await projectAgentsChange(developerSession(), developerEnv(command), project, agentId, add)));
  }
  const projectConnectors = projectCommand.command("connectors").description("a project's connectors: the organization's connections the project's agents may use (to connect a project to Linear, Jira, Asana or an MCP server, see agentx connector)");
  projectConnectors
    .command("list")
    .description("list a project's connectors, their tools and whether each is connected")
    .argument("<project>", "the project's name")
    .action(async (project: string, _options: unknown, command: Command) => printResult(command, await projectConnectorsList(developerSession(), developerEnv(command), project)));
  projectConnectors
    .command("set")
    .description("add or change a connector from a JSON file (a maintainer); a tool newly allowed to write waits on the confirmation page")
    .argument("<project>", "the project's name")
    .argument("<name>", "the connector's name")
    .option("--file <connector.json>", "the connector, as JSON")
    .action(async (project: string, name: string, options: { file?: string }, command: Command) => printResult(command, await projectConnectorsSet(developerSession(), developerEnv(command), project, name, options.file)));
  projectConnectors
    .command("remove")
    .description("remove a connector from a project (a maintainer)")
    .argument("<project>", "the project's name")
    .argument("<name>", "the connector's name")
    .action(async (project: string, name: string, _options: unknown, command: Command) => printResult(command, await projectConnectorsRemove(developerSession(), developerEnv(command), project, name)));
  const commentTriggers = projectConnectors.command("comment-triggers").description("the rule that agent comments wait for a person where workflows act on comments (org owners and admins)");
  commentTriggers
    .command("show")
    .description("scan a repository's workflows: the files read and the digest an opt-out names")
    .argument("<project>", "the project's name")
    .argument("<repository>", "the repository, owner/name")
    .action(async (project: string, repository: string, _options: unknown, command: Command) => printResult(command, await commentTriggersShow(developerSession(), developerEnv(command), project, repository)));
  commentTriggers
    .command("opt-out")
    .description("ask to opt the repository out of the rule for the workflows just scanned; an org admin confirms it on the page")
    .argument("<project>", "the project's name")
    .argument("<repository>", "the repository, owner/name")
    .option("--reason <text>", "why agent comments are safe there")
    .action(async (project: string, repository: string, options: { reason?: string }, command: Command) =>
      printResult(command, await commentTriggersOptOut(developerSession(), developerEnv(command), project, repository, options.reason)));
  projectCommand
    .command("ai")
    .description("a project's AI settings")
    .command("set")
    .description("set a project's AI budget, whether it pays for its runs, and its planning limits (an org owner or admin; a project maintainer may set only --member-accept-run-limit)")
    .argument("<project>", "the project's name")
    .option("--budget <usd|none>", "the project's monthly AI budget")
    .option("--project-pays <on|off>", "whether runs on the project are charged to it")
    .option("--planning-quick <usd|none>", "the most a quick plan may spend; none for the default")
    .option("--planning-full <usd|none>", "the most a full plan may spend; none for the default")
    .option("--member-accept-run-limit <usd|none>", "the most a member may accept as a run limit when the project pays (a project maintainer, an org owner or admin); none for the default $10")
    .action(async (project: string, options: { budget?: string; projectPays?: string; planningQuick?: string; planningFull?: string; memberAcceptRunLimit?: string }, command: Command) =>
      printResult(command, await projectAiSet(developerSession(), developerEnv(command), project, options)));

  const envCommand = program.command("env").description("AgentX environments in this AWS account and region");
  envCommand
    .command("list")
    .description("list the environments installed in this AWS account and region")
    .option("--region <region>", "AWS region to list environments in; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const environments = await runEnvList(parameterStore(options.region));
      if (globals.json) {
        services.stdout.write(formatSuccess({ environments }, true));
      } else {
        services.stdout.write(
          environments.length > 0
            ? environments.map((name) => `${name}\n`).join("")
            : "no environments in this account and region\n",
        );
      }
    });
  envCommand
    .command("use")
    .description("rebuild the selected --env's local settings cache from SSM")
    .option("--region <region>", "AWS region of the environment's SSM parameters; defaults to your AWS configuration")
    .action(async (options: { region?: string }, command: Command) => {
      const globals = globalOptions(command);
      const result = await runEnvUse({ store: parameterStore(options.region), home, env: globals.env });
      services.stdout.write(
        globals.json
          ? formatSuccess(result, true)
          : `Using environment ${result.env} (${result.controlPlaneUrl}); settings saved to ${result.path}\n`,
      );
    });
  envCommand
    .command("adopt")
    .description("register the existing deployment (fixed legacy stack names) as the selected --env, reading its CloudFormation stacks; never changes them")
    .requiredOption("--region <region>", "AWS region of the existing deployment")
    .option("--client-id <id>", "OIDC/Cognito app client ID; defaults to the control plane's OidcAudience")
    .action(async (options: { region: string; clientId?: string }, command: Command) => {
      const globals = globalOptions(command);
      // Always built from --region, even when a test overrides the higher-level store/stacks/sts
      // below: adopt must read the deployment in the named region, never an ambient default.
      const clients = environmentAdoptClients(options.region);
      const result = await runEnvAdopt({
        store: dependencies.environments?.store ?? ssmParameterStore(clients.ssm),
        home,
        env: globals.env,
        region: options.region,
        ...(options.clientId === undefined ? {} : { clientId: options.clientId }),
        stacks: dependencies.environments?.stacks ?? cloudFormationStackReader(clients.cloudFormation),
        identity: dependencies.environments?.sts ?? stsCallerIdentity(clients.sts),
      });
      services.stdout.write(
        globals.json
          ? formatSuccess(result, true)
          : `Adopted ${result.env}: ${result.controlPlaneUrl}; settings in ${settingsParameterName(result.env)}\n`,
      );
    });

  program
    .command("deploy")
    .description("deploy or upgrade an environment from a release; used by init and upgrade, and for automation")
    .addOption(new Option("--mode <mode>", "install a fresh environment or upgrade an existing one").choices(["install", "upgrade"]).makeOptionMandatory())
    .addOption(new Option("--engine <engine>", "deploy engine: pre-synthesized CloudFormation change sets, or a real cdk deploy").choices(["templates", "cdk"]).default("templates"))
    .requiredOption("--release <dir>", "release directory (agentx release build output)")
    .requiredOption("--answers <file>", "deploy answers JSON file (see DeployAnswers)")
    .option("--parts <parts>", "comma-separated subset of parts to deploy, in the mode's order; default: the whole order")
    .option("--source <dir>", "git checkout of the release's source tag; required for --engine cdk")
    .option("--yes", "execute without an interactive change-set confirmation; required for --engine cdk", false)
    .action(async (options: { mode: "install" | "upgrade"; engine: "templates" | "cdk"; release: string; answers: string; parts?: string; source?: string; yes: boolean }, command: Command) => {
      const globals = globalOptions(command);
      // --env is a global option (defaulting to production); only cross-check it against the
      // answers file's own env when the operator actually typed --env, never against the silent
      // default, so an omitted --env keeps working unchanged (the answers file alone decides).
      const envGivenExplicitly = command.getOptionValueSourceWithGlobals("env") === "cli";
      const deployOptions: DeployCommandOptions = {
        mode: options.mode,
        engine: options.engine,
        releaseDir: options.release,
        answersFile: options.answers,
        yes: options.yes,
        ...(options.parts === undefined ? {} : { parts: options.parts }),
        ...(options.source === undefined ? {} : { source: options.source }),
        ...(envGivenExplicitly ? { expectedEnv: globals.env } : {}),
      };
      const result = await runDeploy(deployOptions, dependencies.deploy ?? {}, { stderr: services.stderr });
      const runtimeQualification = result.settingsWritten ? {
        status: "manual-required",
        reason: "deployment does not run a live installation qualification; use a dedicated Linux ARM64 verifier host",
        hostCommand: "docker exec --user node agentx-worker /usr/local/bin/node /opt/agentx/packages/verifier/dist/install-qualification-cli.js --challenge-file /mnt/agentx-runtime/evidence/runtime-install-challenge.json --evidence-root /mnt/agentx-runtime/evidence --out /mnt/agentx-runtime/evidence/runtime-install-proposal.json",
        registrationCommand: `agentx --env ${result.env} admin runtime-installation register --proposal-file ./runtime-install-proposal.json`,
        instructions: "docs/runtime-installation.md",
      } as const : undefined;
      if (globals.json) {
        services.stdout.write(formatSuccess(runtimeQualification ? { ...result, runtimeQualification } : result, true));
        return;
      }
      const lines = [`${options.mode === "install" ? "Installed" : "Upgraded"} environment ${result.env}${result.settingsWritten ? "" : " (not every part is deployed yet)"}`];
      if (!result.settingsWritten) {
        lines.push(
          `Deployed parts: ${result.deployedParts.join(", ") || "none"}`,
          `Missing parts: ${result.missingParts.join(", ") || "none"}`,
          "Environment settings are written once every part is deployed.",
        );
        if (result.missingParts.length > 0) lines.push(`Resume with: ${resumeCommand(deployOptions, result.missingParts)}`);
      } else {
        lines.push(
          "The portable runtime is not live-qualified by deployment; use a dedicated Linux ARM64 verifier host.",
          `On that host: ${runtimeQualification!.hostCommand}`,
          "Copy the proposal back to this operator machine through the approved existing transfer process, then run:",
          `  ${runtimeQualification!.registrationCommand}`,
          `See ${runtimeQualification!.instructions} for challenge issuance and the administrator trust boundary.`,
        );
      }
      services.stdout.write(`${lines.join("\n")}\n`);
    });

  addSignInOptions(
  program
    .command("init")
    .description("install AgentX in this AWS account, step by step, resuming where it stopped; --export writes a bundle for a platform team instead")
    .option("--export <dir>", "write a self-contained bundle a platform team deploys to create the access stack")
    .option("--region <region>", "AWS region to deploy into")
    .option("--account <account>", "AWS account id; defaults to the caller's own account (sts GetCallerIdentity, read-only)")
    .option("--release <dir>", "release directory (agentx release build output); default: download the release matching this agentx. An agentx built from source needs none with --engine cdk --source")
    .addOption(new Option("--engine <engine>", "deploy engine: published CloudFormation templates, or cdk from a source checkout").choices(["templates", "cdk"]))
    .option("--source <dir>", "clean git checkout of a release tag; required for --engine cdk. An agentx built from source takes the version from its tag")
    .option("--resume", "only continue an install already under way; never start a new one", false)
    .option("--from-bundle <dir>", "with --resume: continue an install whose access stack a platform team deployed from this export bundle")
    .option("--yes", "answer every question with its default or its flag, without asking; the plan is still printed. Confirmations such as the Slack bot and workspace check and \"Request URL Verified?\" are answered yes, so check the printed summary afterwards", false)
    .option("--no-browser", "print every address to open instead of opening a browser, and ask in the terminal unless --ui is given")
    .option("--ui", "ask every question on a page on 127.0.0.1 (the default in an interactive terminal that can open a browser)")
    .option("--no-ui", "ask every question in the terminal")
    .option("--setup-table <name>", "the installer job in the cloud: ask every question on the setup page, through this DynamoDB table (needs --setup-url)")
    .option("--setup-url <url>", "the setup page's address, printed for the job's log (with --setup-table)")
    .addOption(new Option("--identity <mode>", "identity provider").choices(["cognito", "oidc"]).default("cognito"))
    .option("--oidc-issuer <url>", "your OIDC provider's issuer URL (required with --identity oidc)")
    .option("--oidc-audience <audience>", "your OIDC provider's audience (required with --identity oidc)")
    .option("--oidc-client-id <id>", "your OIDC provider's client id, needed for agentx login")
    .option("--admin-claim <claim>", "the OIDC claim that marks AgentX administrators")
    .option("--admin-values <values>", "comma-separated values of --admin-claim that mark an administrator")
    .option("--permission-boundary <arn>", "IAM permissions boundary ARN applied to every role AgentX creates")
    .option("--operator-principal <arn>", "IAM principal ARN allowed to assume the AgentX operator role")
    .addOption(new Option("--model-provider <provider>", "model provider for the orchestrator, classifier and worker; a per-component provider flag wins over it").choices([...MODEL_PROVIDERS]))
    .option("--orchestrator-provider <provider>", "amazon-bedrock (default), openrouter, anthropic or openai")
    .option("--classifier-provider <provider>", "amazon-bedrock (default), openrouter, anthropic or openai")
    .option("--worker-provider <provider>", "amazon-bedrock (default), openrouter, anthropic or openai")
    .option("--openrouter-key-file <path>", "file holding the OpenRouter API key; init stores it in agentx/<env>/openrouter")
    .option("--openrouter-key-env <NAME>", "environment variable holding the OpenRouter API key; init stores it in agentx/<env>/openrouter")
    .option("--openrouter-secret-arn <arn>", "a Secrets Manager secret you made yourself holding the raw OpenRouter key; init then asks for no key")
    .option("--openrouter-providers <slugs>", "comma-separated OpenRouter provider allowlist")
    .option("--anthropic-key-file <path>", "file holding your Anthropic API key; init stores it in agentx/<env>/anthropic")
    .option("--anthropic-key-env <NAME>", "environment variable holding your Anthropic API key; init stores it in agentx/<env>/anthropic")
    .option("--anthropic-secret-arn <arn>", "a Secrets Manager secret you made yourself holding the raw Anthropic API key; init then asks for no key")
    .option("--openai-key-file <path>", "file holding your OpenAI API key; init stores it in agentx/<env>/openai")
    .option("--openai-key-env <NAME>", "environment variable holding your OpenAI API key; init stores it in agentx/<env>/openai")
    .option("--openai-secret-arn <arn>", "a Secrets Manager secret you made yourself holding the raw OpenAI API key; init then asks for no key")
    .option("--orchestrator-model <id>", "Provider model id for the Slack orchestrator", DEFAULT_ORCHESTRATOR_MODEL)
    .option("--classifier-model <id>", "Provider model id for the gate classifier", DEFAULT_CLASSIFIER_MODEL)
    .option("--worker-model <id>", "Provider model id for the runtime worker", DEFAULT_WORKER_MODEL)
    .option("--alert-email <address>", "email address AgentX sends alerts to")
    .option("--alert-webhook-file <path>", "file holding a PagerDuty or Opsgenie integration address (kept secret)")
    .option("--alert-webhook-env <NAME>", "environment variable holding a PagerDuty or Opsgenie integration address (kept secret)")
    .option("--no-alerts", "send alerts nowhere for now")
    .option("--edition <edition>", "the edition of this install: enterprise (an install in your own AWS account) or public (with --rovara-cloud); needs the cdk engine. A new install with the cdk engine must choose")
    .option("--rovara-cloud", "install the hosted Rovara cloud (self-serve sign-in, multi-tenant orgs); needs the cdk engine")
    .option("--google-client-id <id>", "with --rovara-cloud: the Google OAuth client id for sign-in (omit for email-code sign-in only)")
    .option("--google-client-secret-arn <arn>", "with --rovara-cloud: the Secrets Manager secret holding the Google client secret as {\"clientSecret\": ...}")
    .option("--cloud-domain-prefix <prefix>", "with --rovara-cloud: the hosted sign-in domain prefix (default rovara-<env>)")
    .option("--github-sign-in-client-id <id>", "with --rovara-cloud: the GitHub OAuth app client id for sign up and sign in with GitHub (omit to not offer it)")
    .option("--github-sign-in-client-secret-arn <arn>", "with --rovara-cloud: the Secrets Manager secret holding the GitHub OAuth client secret as {\"clientSecret\": ...}")
    .option("--budget <usd>", "monthly AWS budget in whole US dollars; 0 for none (default 100)")
    .addOption(new Option("--budget-scope <scope>", "tag: costs tagged agentx:env; account: the whole account").choices(["tag", "account"]))
    .addOption(new Option("--audit-lock <profile>", "production: audit records are locked for 3 years (default); trial: locked for 1 day and removable by an operator. An install can move from trial to production, never back").choices(["production", "trial"]))
    .option("--github-account <login>", "GitHub organization or user that will own the AgentX GitHub App")
    .addOption(new Option("--github-account-type <type>", "whether --github-account is an organization or a personal account").choices(["organization", "user"]))
    .option("--github-app-name <name>", "GitHub App name (unique on GitHub)")
    .option("--github-app-id <id>", "a GitHub App made beforehand: its app id")
    .option("--github-installation-id <id>", "a GitHub App made beforehand: its installation id")
    .option("--github-private-key-file <path>", "a GitHub App made beforehand: its private key .pem file")
    .option("--github-private-key-env <NAME>", "a GitHub App made beforehand: environment variable holding its private key")
    .option("--slack-app-name <name>", "Slack app name")
    .addOption(new Option("--slack-app-posted-messages <mode>", "answer mentions people post through other apps with their own Slack token").choices(["accept", "ignore"]))
    .addOption(new Option("--slack-install <state>", "whether the Slack app is installed, or waits for an admin's approval (default with --yes: installed)").choices(["installed", "approval"]))
    .option("--slack-bot-token-file <path>", "file holding the Slack Bot User OAuth Token")
    .option("--slack-bot-token-env <NAME>", "environment variable holding the Slack Bot User OAuth Token")
    .option("--slack-signing-secret-file <path>", "file holding the Slack signing secret")
    .option("--slack-signing-secret-env <NAME>", "environment variable holding the Slack signing secret")
    .option("--worker-image <digest-ref>", "worker image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--boot-stage2-sha256 <hex>", "with --worker-image: the SHA-256 of packages/worker/ec2/boot-stage2.sh in the release source that image was built from (a release supplies its own)")
    .option("--slack-image <digest-ref>", "Slack service image by digest; an agentx built from source needs it with --engine cdk when the tag has no published release.json")
    .option("--admin-email <email>", "Cognito: your email, for the AgentX admin user")
    .option("--repository <owner/name>", "the first project's repository")
    .option("--project-name <name>", "the first project's name (default: the repository's)")
    .option("--setup-command <command>", "the first project's setup command, or \"\" for none")
    .option("--test-command <command>", "the first project's test command, or \"\" for none")
    .option("--channel <name>", "the Slack channel for the first project")
    .option("--connectors <list>", "connectors to add now: comma-separated linear, jira, asana, or none")
    .option("--linear-key-file <path>", "file holding the Linear API key")
    .option("--linear-key-env <NAME>", "environment variable holding the Linear API key")
    .option("--linear-team <id or key>", "the Linear team the first project may use")
    .option("--jira-site <site>", "the <site> in <site>.atlassian.net")
    .option("--jira-project <key>", "the Jira project key")
    .option("--jira-token-file <path>", "file holding the Jira service account's API token")
    .option("--jira-token-env <NAME>", "environment variable holding the Jira service account's API token")
    .option("--asana-client-id <id>", "the Asana MCP app's Client ID")
    .option("--asana-client-secret-file <path>", "file holding the Asana app's Client secret")
    .option("--asana-client-secret-env <NAME>", "environment variable holding the Asana app's Client secret")
    .option("--asana-bot-email <email>", "the Asana bot user's email; a sign-in by any other account is refused")
    .option("--asana-project <gid>", "the Asana project's GID"),
  )
    .addOption(new Option(`${SIGNIN_FLAG_NAMES.methods} <method>`, "how developers sign in: Slack (default), your company's sign-in (oidc), or both").choices(["slack", "oidc", "both"]))
    // Checked in initOptions, not with .choices(): commander would exit the process on a bad value.
    .option("--stop-after <step>", "run the steps up to and including this one, then stop; agentx init again finishes (for automated tests)")
    .action(async (
      options: InitCommandOptions & { export?: string },
      command: Command,
    ) => {
      const globals = globalOptions(command);
      if (options.export !== undefined && options.stopAfter !== undefined) throw agentXError("CONFIG_INVALID", "--stop-after cannot be used with --export, which runs no init step; drop one of them");
      if (options.export === undefined) {
        let result: Awaited<ReturnType<typeof runInit>>;
        try {
          result = await runInit(initOptions(globals, options, command), dependencies.init ?? {}, { stderr: services.stderr, home });
        } catch (error) {
          // Issue #235: Ctrl-C at a terminal question stops the install where it is; it can continue.
          // Owner decision 2026-10-02: the same command-line helper as the ready screen and the
          // other live messages, so this shows bare or npx exactly as the person just ran AgentX.
          if (isCtrlCAtPrompt(error)) {
            const initInvocation = dependencies.init?.cliInvocation ?? cliInvocation;
            throw new StoppedByOperator(`Stopped. Run ${cliCommandLine(initInvocation, `init --env ${globals.env}`)} again to continue from here.`);
          }
          throw error;
        }
        if (globals.json) {
          // pageMode is the CLI's own note that the page already told the person; not part of the result.
          // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to drop the key
          const { pageMode: _pageMode, ...printed } = result;
          services.stdout.write(formatSuccess(printed, true));
          return;
        }
        if (result.pageMode === true) return;
        if (result.status === "waiting") {
          services.stdout.write(`${result.message}\n`);
          return;
        }
        if (result.stoppedAfter !== undefined) {
          services.stdout.write(`Stopped after the ${result.stoppedAfter} step, as --stop-after asked. Run agentx init --env ${result.env} --region ${options.region ?? "<region>"} again to finish.\n`);
          return;
        }
        services.stdout.write(`${result.ready ?? `AgentX environment ${result.env} is deployed. Control plane: ${result.controlPlaneUrl ?? "unknown"}`}\n`);
        return;
      }
      // --env defaults to production (the live, legacy-adopted deployment): --export must never
      // silently write a bundle for it just because --env was left off.
      if (command.getOptionValueSourceWithGlobals("env") !== "cli") {
        throw agentXError("CONFIG_INVALID", "agentx init --export requires an explicit --env (the default, production, is the live environment)");
      }
      if (options.region === undefined) throw agentXError("CONFIG_INVALID", "--region is required with --export");
      if (options.release === undefined) throw agentXError("CONFIG_INVALID", "--release is required with --export");
      if (options.openrouterKeyFile !== undefined || options.openrouterKeyEnv !== undefined) {
        throw agentXError("CONFIG_INVALID", "--export stores no secret, so it takes no OpenRouter key; create the secret yourself and pass --openrouter-secret-arn");
      }
      for (const [label, flag, file, env] of [["Anthropic", "anthropic", options.anthropicKeyFile, options.anthropicKeyEnv], ["OpenAI", "openai", options.openaiKeyFile, options.openaiKeyEnv]] as const) {
        if (file !== undefined || env !== undefined) throw agentXError("CONFIG_INVALID", `--export stores no secret, so it takes no ${label} key; create the secret yourself and pass --${flag}-secret-arn`);
      }
      const exportProvider = (component?: string) => component ?? options.modelProvider;
      // A direct provider's role takes its suggested model unless one was typed: the commander
      // default is a Bedrock model ID.
      const exportModel = (role: "orchestrator" | "classifier" | "worker", component?: string): string => {
        const provider = exportProvider(component);
        const typedModel = command.getOptionValueSource(`${role}Model`) === "cli";
        return !typedModel && (provider === "anthropic" || provider === "openai") ? DEFAULT_DIRECT_MODELS[provider][role] : options[`${role}Model`];
      };
      const result = await runInitExport(
        {
          env: globals.env,
          dir: options.export,
          region: options.region,
          releaseDir: options.release,
          identity: options.identity,
          orchestratorModel: exportModel("orchestrator", options.orchestratorProvider),
          classifierModel: exportModel("classifier", options.classifierProvider),
          workerModel: exportModel("worker", options.workerProvider),
          ...(exportProvider(options.orchestratorProvider) ? { orchestratorProvider: exportProvider(options.orchestratorProvider) } : {}),
          ...(exportProvider(options.classifierProvider) ? { classifierProvider: exportProvider(options.classifierProvider) } : {}),
          ...(exportProvider(options.workerProvider) ? { workerProvider: exportProvider(options.workerProvider) } : {}),
          ...(options.openrouterSecretArn ? { openrouterSecretArn: options.openrouterSecretArn } : {}),
          ...(options.openrouterProviders ? { openrouterProviders: options.openrouterProviders } : {}),
          ...(options.anthropicSecretArn ? { anthropicSecretArn: options.anthropicSecretArn } : {}),
          ...(options.openaiSecretArn ? { openaiSecretArn: options.openaiSecretArn } : {}),
          ...(options.account === undefined ? {} : { account: options.account }),
          ...(options.oidcIssuer === undefined ? {} : { oidcIssuer: options.oidcIssuer }),
          ...(options.oidcAudience === undefined ? {} : { oidcAudience: options.oidcAudience }),
          ...(options.oidcClientId === undefined ? {} : { oidcClientId: options.oidcClientId }),
          ...(options.adminClaim === undefined ? {} : { adminClaim: options.adminClaim }),
          ...(options.adminValues === undefined ? {} : { adminValues: options.adminValues }),
          ...(options.permissionBoundary === undefined ? {} : { permissionsBoundaryArn: options.permissionBoundary }),
          ...(options.operatorPrincipal === undefined ? {} : { operatorPrincipalArn: options.operatorPrincipal }),
        },
        dependencies.deploy ?? {},
      );
      services.stdout.write(
        globals.json
          ? formatSuccess(result, true)
          : `Wrote export bundle to ${result.dir}\nNext: have your platform team run ${result.dir}/deploy-access.sh (see ${result.dir}/README.md) with their own AWS credentials to deploy the access stack.\n`,
      );
    });

  /** R24 and spec 025 A14: this computer's unexpired admin sign-in for the developer's environment. Never refreshed (Q4). */
  const adminSession = async (env: string | undefined): Promise<AdminSession | undefined> => {
    let name: string;
    try {
      name = (await resolveDeveloperEnvironment(home, env)).env;
    } catch {
      return undefined;
    }
    return adminSessionFor(name);
  };
  const adminSignedIn = async (env: string | undefined): Promise<boolean> => (await adminSession(env)) !== undefined;
  /** Issue #218: the developer's environment and its stored admin sign-in's expiry, expired or not. */
  const adminSignInExpiry = async (env: string | undefined): Promise<{ env: string; expiresAt: number } | undefined> => {
    let name: string;
    try {
      name = (await resolveDeveloperEnvironment(home, env)).env;
    } catch {
      return undefined;
    }
    const stored = await storedAdminSignIn(name);
    return stored === undefined ? undefined : { env: name, expiresAt: stored.expiresAt };
  };

  const mcp = program
    .command("mcp")
    .description("run the AgentX MCP server for your AI tool (stdio); add it with agentx mcp install")
    .action(async (_options: unknown, command: Command) => {
      // FR-026: stdout carries only MCP messages, so everything else this command says goes to stderr.
      const env = developerEnv(command);
      const shutdown = new AbortController();
      const stop = () => shutdown.abort();
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      try {
        await runMcpServer({
          ...developerSession(),
          ...(env === undefined ? {} : { env }),
          adminSignedIn,
          adminSession,
          adminSignInExpiry,
          cliInvocation,
          stdin: dependencies.stdin ?? process.stdin,
          stdout: (dependencies.stdout ?? process.stdout) as Writable,
          stderr: services.stderr,
          shutdown: shutdown.signal,
          ...(dependencies.mcpClock === undefined ? {} : { clock: dependencies.mcpClock }),
        });
      } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
      }
    });

  mcp
    .command("install")
    .description("add the AgentX MCP server to Claude Code, Codex or Cursor")
    .addOption(new Option("--client <client>", "the AI tool").choices([...MCP_CLIENTS]).makeOptionMandatory())
    .option("--print", "only print the entry; change nothing", false)
    .action(async (options: { client: McpClientKind; print: boolean }, command: Command) => {
      const env = developerEnv(command);
      services.stdout.write(await installMcp(options.client, { print: options.print, ...(env === undefined ? {} : { env }) }, { home, codexHome: dependencies.codexHome ?? codexHomeFromEnvironment(), run: dependencies.runCommand ?? runCommand, version: RELEASE_VERSION }));
    });

  return program;
}

/** Codex's own settings folder override; an empty CODEX_HOME counts as unset. */
function codexHomeFromEnvironment(): string | undefined {
  const value = process.env.CODEX_HOME;
  return value === undefined || value === "" ? undefined : value;
}

/**
 * `agentx agents run <id> --version <n>`: the program's own --version flag would print the CLI's version wherever it appears, so for that
 * one command its `--version <n>` (or `--version=<n>`) is handed over as --run-version. Every other --version is left as it is.
 */
export function agentRunVersionArgv(argv: readonly string[]): string[] {
  // The command's words, skipping the program's options and the values they take.
  const words: number[] = [];
  for (let index = 0; index < argv.length && words.length < 2; index += 1) {
    const word = argv[index]!;
    if (PROGRAM_VALUE_OPTIONS.has(word)) index += 1;
    else if (!word.startsWith("-")) words.push(index);
  }
  if (words.length < 2 || argv[words[0]!] !== "agents" || argv[words[1]!] !== "run") return [...argv];
  return argv.map((word, index) => {
    if (index <= words[1]!) return word;
    if (word === "--version" && argv[index + 1] !== undefined && !argv[index + 1]!.startsWith("-")) return "--run-version";
    return word.startsWith("--version=") ? `--run-version=${word.slice("--version=".length)}` : word;
  });
}
const PROGRAM_VALUE_OPTIONS = new Set(["--project", "--config-dir", "--deployment-file", "--env"]);

export async function executeCli(argv = process.argv.slice(2), dependencies: CliDependencies = {}): Promise<number> {
  try {
    await createCliProgram(dependencies).parseAsync(agentRunVersionArgv(argv), { from: "user" });
    return 0;
  } catch (error) {
    const json = argv.includes("--json");
    const failure = formatError(error, json);
    (dependencies.stderr ?? process.stderr).write(failure.text);
    return failure.exitCode;
  }
}

/**
 * Turns a failure partway through a file export into one naming how many records were written
 * before it happened, so a caller never mistakes a stopped export for a complete one. Keeps the
 * original error's class and, for an AgentXError, its code, so the exit-code mapping is unchanged.
 */
function exportFailure(error: unknown, written: number, target: "file" | "stdout"): unknown {
  const cause = error instanceof Error ? error.message : String(error);
  // Records already printed to stdout stay printed; only a file export can promise nothing was written.
  const message = target === "file"
    ? `turn export failed after ${written} records; no file was written: ${cause}`
    : `turn export failed after ${written} records: ${cause}`;
  if (error instanceof AgentXError) return agentXError(error.code, message);
  if (error instanceof Error) {
    error.message = message;
    return error;
  }
  return new Error(message);
}

/** The server's warnings, plus a note when a control plane too old to run preflight answered. */
function registrationWarnings(result: unknown, definition: ProjectDefinition): string[] {
  const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const warnings = Array.isArray(record.warnings) ? record.warnings.filter((entry): entry is string => typeof entry === "string") : [];
  if (definition.integrations && record.preflight === undefined) {
    warnings.push("this control plane did not check connectors at registration; deploy the latest AgentX release to get the preflight report.");
  }
  return warnings;
}

async function projectFromFile(path: string, allowLoopback: boolean): Promise<ProjectDefinition> {
  const absolute = resolve(path);
  if (extname(absolute) !== ".yaml") throw agentXError("CONFIG_INVALID", "project file must use .yaml");
  return loadProjectConfig({
    projectName: basename(absolute, ".yaml"),
    configDirectory: dirname(absolute),
    allowLoopback,
  });
}

function requireProject(options: Pick<GlobalOptions, "project">): string {
  if (!options.project) throw agentXError("CONFIG_INVALID", "--project is required");
  return options.project;
}

function parsePort(value: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw agentXError("CONFIG_INVALID", "callback port must be from 1 through 65535");
  }
  return port;
}

interface InitCommandOptions extends SignInCommandOptions {
  region?: string; account?: string; release?: string; engine?: "templates" | "cdk"; source?: string;
  resume: boolean; yes: boolean; browser: boolean; fromBundle?: string; stopAfter?: string;
  /** --ui / --no-ui. Undefined when neither was given (resolveUiMode decides). */
  ui?: boolean;
  setupTable?: string; setupUrl?: string;
  identity: "cognito" | "oidc"; oidcIssuer?: string; oidcAudience?: string; oidcClientId?: string; adminClaim?: string; adminValues?: string;
  modelProvider?: string; orchestratorProvider?: string; classifierProvider?: string; workerProvider?: string; openrouterSecretArn?: string; openrouterProviders?: string;
  openrouterKeyFile?: string; openrouterKeyEnv?: string;
  anthropicSecretArn?: string; anthropicKeyFile?: string; anthropicKeyEnv?: string;
  openaiSecretArn?: string; openaiKeyFile?: string; openaiKeyEnv?: string;
  permissionBoundary?: string; operatorPrincipal?: string; orchestratorModel: string; classifierModel: string; workerModel: string;
  alertEmail?: string; alertWebhookFile?: string; alertWebhookEnv?: string; alerts: boolean;
  budget?: string; budgetScope?: "tag" | "account"; auditLock?: "production" | "trial";
  githubAccount?: string; githubAccountType?: "organization" | "user"; githubAppName?: string;
  githubAppId?: string; githubInstallationId?: string; githubPrivateKeyFile?: string; githubPrivateKeyEnv?: string;
  slackAppName?: string; slackAppPostedMessages?: "accept" | "ignore"; slackInstall?: "installed" | "approval";
  slackBotTokenFile?: string; slackBotTokenEnv?: string; slackSigningSecretFile?: string; slackSigningSecretEnv?: string;
  workerImage?: string; slackImage?: string; bootStage2Sha256?: string;
  rovaraCloud?: boolean; edition?: string; googleClientId?: string; googleClientSecretArn?: string; cloudDomainPrefix?: string;
  githubSignInClientId?: string; githubSignInClientSecretArn?: string;
  /** --signin: which developer sign-in methods agentx init's developer-signin step enables. */
  signin?: "slack" | "oidc" | "both";
  adminEmail?: string; repository?: string; projectName?: string; setupCommand?: string; testCommand?: string; channel?: string; connectors?: string;
  linearKeyFile?: string; linearKeyEnv?: string; linearTeam?: string;
  jiraSite?: string; jiraProject?: string; jiraTokenFile?: string; jiraTokenEnv?: string;
  asanaClientId?: string; asanaClientSecretFile?: string; asanaClientSecretEnv?: string; asanaBotEmail?: string; asanaProject?: string;
}

/** `agentx init`'s options, built from only what was typed: a commander default (the models,
 * --identity, --no-alerts's true) must never silently answer a question init would otherwise ask. */
function initOptions(globals: GlobalOptions, options: InitCommandOptions, command: Command): InitOptions {
  const { env } = globals;
  const { stopAfter } = options;
  if (stopAfter !== undefined && !isInitStepId(stopAfter)) {
    throw agentXError("CONFIG_INVALID", `--stop-after ${JSON.stringify(stopAfter)} names no init step; use one of: ${INIT_STEP_IDS.join(", ")}`);
  }
  // A --connectors typo fails here, before anything is asked or deployed.
  if (options.connectors !== undefined) parseConnectorsFlag(options.connectors);
  const finishFlags = definedEntries<FinishFlags>({
    adminEmail: options.adminEmail, repository: options.repository, projectName: options.projectName,
    setupCommand: options.setupCommand, testCommand: options.testCommand, channel: options.channel,
    // Under --yes, no --connectors means none: an unattended run never starts a connector's questions.
    connectors: options.connectors ?? (options.yes ? "none" : undefined),
    linearKey: secretSource(options.linearKeyFile, options.linearKeyEnv), linearTeam: options.linearTeam,
    jiraSite: options.jiraSite, jiraProject: options.jiraProject, jiraToken: secretSource(options.jiraTokenFile, options.jiraTokenEnv),
    asanaClientId: options.asanaClientId, asanaClientSecret: secretSource(options.asanaClientSecretFile, options.asanaClientSecretEnv),
    asanaBotEmail: options.asanaBotEmail, asanaProject: options.asanaProject,
  });
  const typed = <T>(name: string, value: T): T | undefined => (command.getOptionValueSource(name) === "cli" ? value : undefined);
  const flags = definedEntries<InitFlags>({
    engine: options.engine,
    identity: typed("identity", options.identity),
    oidcIssuer: options.oidcIssuer, oidcAudience: options.oidcAudience, oidcClientId: options.oidcClientId,
    adminClaim: options.adminClaim, adminValues: options.adminValues,
    orchestratorModel: typed("orchestratorModel", options.orchestratorModel),
    classifierModel: typed("classifierModel", options.classifierModel),
    workerModel: typed("workerModel", options.workerModel),
    modelProvider: options.modelProvider,
    orchestratorProvider: options.orchestratorProvider, classifierProvider: options.classifierProvider, workerProvider: options.workerProvider,
    openrouterSecretArn: options.openrouterSecretArn, openrouterProviders: options.openrouterProviders,
    openrouterKey: secretSource(options.openrouterKeyFile, options.openrouterKeyEnv),
    anthropicSecretArn: options.anthropicSecretArn, anthropicKey: secretSource(options.anthropicKeyFile, options.anthropicKeyEnv),
    openaiSecretArn: options.openaiSecretArn, openaiKey: secretSource(options.openaiKeyFile, options.openaiKeyEnv),
    permissionBoundary: options.permissionBoundary, operatorPrincipal: options.operatorPrincipal,
    alertEmail: options.alertEmail,
    alertWebhook: secretSource(options.alertWebhookFile, options.alertWebhookEnv),
    alerts: typed("alerts", options.alerts),
    budget: options.budget, budgetScope: options.budgetScope, auditLock: options.auditLock,
    githubAccount: options.githubAccount, githubAccountType: options.githubAccountType, githubAppName: options.githubAppName,
    slackAppName: options.slackAppName, slackAppPostedMessages: options.slackAppPostedMessages,
    workerImage: options.workerImage, slackImage: options.slackImage, bootStage2Sha256: options.bootStage2Sha256,
    rovaraCloud: options.rovaraCloud, edition: options.edition, googleClientId: options.googleClientId, googleClientSecretArn: options.googleClientSecretArn, cloudDomainPrefix: options.cloudDomainPrefix,
    githubSignInClientId: options.githubSignInClientId, githubSignInClientSecretArn: options.githubSignInClientSecretArn,
  });
  const keySource = secretSource(options.githubPrivateKeyFile, options.githubPrivateKeyEnv);
  const { githubAppId: appId, githubInstallationId: installationId } = options;
  const preMadeGiven = appId !== undefined || installationId !== undefined;
  if (preMadeGiven && (appId === undefined || installationId === undefined || keySource === undefined)) {
    throw agentXError("CONFIG_INVALID", "--github-app-id, --github-installation-id and --github-private-key-file (or --github-private-key-env) go together");
  }
  if ((options.setupTable === undefined) !== (options.setupUrl === undefined)) {
    throw agentXError("CONFIG_INVALID", "--setup-table and --setup-url go together");
  }
  if (options.setupTable !== undefined && (options.ui === false || options.yes)) {
    throw agentXError("CONFIG_INVALID", "--setup-table asks every question on the setup page; leave out --no-ui and --yes");
  }
  const signin = signInFlags(options);
  const secretFlags = definedEntries<SecretFlags>({
    slackBotToken: secretSource(options.slackBotTokenFile, options.slackBotTokenEnv),
    slackSigningSecret: secretSource(options.slackSigningSecretFile, options.slackSigningSecretEnv),
    githubPrivateKey: keySource,
    slackClientSecret: signin.secretFlags.slackClientSecret,
    oidcClientSecret: signin.secretFlags.oidcClientSecret,
  });
  return {
    env,
    ...(options.region === undefined ? {} : { region: options.region }),
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.release === undefined ? {} : { releaseDir: options.release }),
    ...(options.source === undefined ? {} : { source: options.source }),
    ...(options.fromBundle === undefined ? {} : { fromBundle: options.fromBundle }),
    yes: options.yes, browser: options.browser, resume: options.resume,
    ...(options.ui === undefined ? {} : { ui: options.ui }),
    ...(options.setupTable === undefined || options.setupUrl === undefined ? {} : { cloud: { table: options.setupTable, url: options.setupUrl } }),
    flags,
    secretFlags,
    signinFlags: definedEntries<SigninFlags>({ methods: options.signin, ...signin.flags }),
    ...(appId === undefined || installationId === undefined ? {} : { preMadeGitHubApp: { appId, installationId } }),
    ...(options.slackInstall === undefined ? {} : { slackInstall: options.slackInstall }),
    finishFlags,
    configDir: globals.configDir,
    ...(stopAfter === undefined ? {} : { stopAfter }),
  };
}

function isInitStepId(value: string): value is InitStepId {
  return (INIT_STEP_IDS as readonly string[]).includes(value);
}

function globalOptions(command: Command): GlobalOptions {
  return command.optsWithGlobals<GlobalOptions>();
}

function isDirectExecution(): boolean {
  const script = process.argv[1];
  return script !== undefined && pathToFileURL(realpathSync(resolve(script))).href === import.meta.url;
}

if (isDirectExecution()) {
  process.exitCode = await executeCli();
}
