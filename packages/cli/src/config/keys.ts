// FR-048: agentx config's fixed, documented keys. Each maps to exactly one place: a stack parameter,
// an SSM value (the environment settings) or a control-plane setting. docs/day-two.md lists the
// same table.
import { UI_FLAG_NAMES, UI_FLAGS_FORCE_OFF_ALL, UI_FLAGS_FORCE_OFF_NONE, UiFlagNameSchema } from "@agentx/cloud-contracts";
import { CHATGPT_DEFAULT_PREFERRED_MODEL, ChatGptModelIdSchema, MODEL_FALLBACK_NONE, MODEL_FALLBACK_PATTERN, agentXError, environmentSettingsPrefix, environmentStackName } from "@rovara-code/contracts";
import { catalogModel } from "@agentx/model-runtime/catalog";
import { AlertEmailSchema, MAX_BUDGET_USD } from "../deploy/answer-schemas.js";
import type { DeployPart } from "../deploy/parameters.js";
import type { ModelRole } from "../init/prerequisites.js";

export type { ModelRole } from "../init/prerequisites.js";

export type ConfigTarget =
  /** `also`: the same value goes to these stacks' parameters too, one after the other (models.fallback: the runtime and the Slack stack both need it). */
  | { kind: "stack-parameter"; part: DeployPart; parameter: string; also?: ReadonlyArray<{ part: DeployPart; parameter: string }> }
  | { kind: "settings"; field: "alertAddress" | "teamRecordOptions" }
  | { kind: "control-plane-setting"; field: "perPerson" | "perOrganization"; installDefault: { part: DeployPart; parameter: string } }
  // #343: Sign in with ChatGPT's settings, held by the control plane alone (no stack parameter).
  | { kind: "chatgpt-setting"; field: "enabled" | "preferredModel" };

export interface ConfigKey {
  key: string;
  description: string;
  target: ConfigTarget;
  /** The template's default, shown when the stack reports no value. */
  defaultValue?: string;
  /** The AI navigation model choice (Task 4.10): held to the models Rovara can use with the environment's provider and region before anything changes. It has no coding-model test call. */
  e2eAgentModel?: true;
  /** The coding roles' fallback model (Task 4.10D): `none`, or a Bedrock model of the pinned catalog that passes the one-token test call before anything changes. */
  fallbackModel?: true;
  /** Model keys pass a one-token test call before anything changes (FR-049). */
  model?: ModelRole;
  /** UX-4b: the Team record. Its storage is built at synth time, so turning it on records the choice for every later cdk command (team-record-switch.ts) and the next upgrade builds it; once built, the stack parameter pauses or resumes it and keeps its data. */
  teamRecord?: true;
  /** The value to store, or CONFIG_INVALID saying what is allowed. */
  parse(value: string): string;
}

const refuse = (key: string, allowed: string): never => {
  throw agentXError("CONFIG_INVALID", `${key} must be ${allowed}; nothing changed`);
};

const wholeNumber = (key: string, min: number, max: number) => (value: string): string => {
  const trimmed = value.trim();
  if (!/^[0-9]{1,8}$/.test(trimmed) || Number(trimmed) < min || Number(trimmed) > max) return refuse(key, `a whole number from ${min} to ${max}`);
  return String(Number(trimmed));
};

/** `none`, `all`, or known screen names joined by a hyphen. Unlike the broker (which fails closed on a mistake), the command refuses it before anything changes. */
const uiFlagsForceOffValue = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === UI_FLAGS_FORCE_OFF_NONE || trimmed === UI_FLAGS_FORCE_OFF_ALL) return trimmed;
  const parts = trimmed.split("-");
  return parts.every((part) => UiFlagNameSchema.safeParse(part).success) && trimmed.length <= 64 ? trimmed : refuse(key, `none, all, or screen names (${UI_FLAG_NAMES.join(", ")}) joined by a hyphen, at most 64 characters`);
};

const oneOf = (key: string, values: readonly string[]) => (value: string): string =>
  (values.includes(value.trim()) ? value.trim() : refuse(key, `one of ${values.join(", ")}`));

// A Bedrock model or inference-profile id, or an OpenRouter slug: no spaces, at most 200 characters.
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const modelId = (key: string) => (value: string): string => (MODEL_ID.test(value.trim()) ? value.trim() : refuse(key, "a model id"));

/** `default` (Rovara's recommendation) or a model id; the environment's provider and region decide which ids are usable, which only the command knows. */
const e2eAgentModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  return trimmed === "default" || MODEL_ID.test(trimmed) ? trimmed : refuse(key, "default or a model id");
};

/** `none`, or the id of a Bedrock model in the pinned catalog: the fallback is never a model this Rovara does not know. */
const fallbackModel = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === MODEL_FALLBACK_NONE) return trimmed;
  if (MODEL_FALLBACK_PATTERN.test(trimmed) && catalogModel({ provider: "amazon-bedrock", modelId: trimmed }) !== undefined) return trimmed;
  return refuse(key, "none or a Bedrock model of this Rovara's model catalog");
};

const email = (key: string) => (value: string): string => (AlertEmailSchema.safeParse(value.trim()).success ? value.trim() : refuse(key, "an email address"));

export const EMBEDDER_IMAGE = /^[0-9]{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com(?:\.cn)?\/[a-z0-9][a-z0-9._/-]{1,255}@sha256:[a-f0-9]{64}$/u;
/** A private ECR image reference pinned by digest (the stack parameter's own pattern, infra/lib/embedder-function.ts). `none` is refused: the Team record has no keyword-only mode. */
const embedderImage = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "none") return refuse(key, "an image pinned by digest. There is no \"none\": the Team record cannot search without its embedder");
  return EMBEDDER_IMAGE.test(trimmed) ? trimmed : refuse(key, "a private ECR image pinned by digest (<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<64 hex>)");
};

/** The account and region an embedder image reference names (the pattern above), or undefined. */
export function embedderImageHome(value: string): { account: string; region: string } | undefined {
  const match = /^([0-9]{12})\.dkr\.ecr\.([a-z0-9-]+)\./u.exec(value);
  return match === null ? undefined : { account: match[1] as string, region: match[2] as string };
}

/**
 * The task people invitation switches (TaskPeoplePublicInvitationsEnabled, TaskPeoplePrivateInvitationsEnabled) can be turned off and not on: automatic Slack invitations of task people are
 * deferred (owner decision 86), because they need a Slack reinstall with new scopes and the invite handler is wired nowhere. A switch that did nothing must not read as one that works.
 */
const invitationsDeferred = (key: string) => (value: string): string => {
  const trimmed = value.trim();
  if (trimmed === "false") return trimmed;
  if (trimmed === "true") return refuse(key, "false for now: automatic Slack invitations are not built yet (they need a Slack reinstall with new scopes)");
  return refuse(key, "false");
};

const parameter = (part: DeployPart, name: string): ConfigTarget => ({ kind: "stack-parameter", part, parameter: name });

export const CONFIG_KEYS: readonly ConfigKey[] = [
  { key: "models.orchestrator", description: "the model the Slack orchestrator uses", target: parameter("slack", "ModelId"), model: "orchestrator", parse: modelId("models.orchestrator") },
  { key: "models.classifier", description: "the model the gate classifier uses", target: parameter("slack", "GateClassifierModelId"), model: "classifier", parse: modelId("models.classifier") },
  { key: "models.worker", description: "the model the coding worker uses", target: parameter("runtime", "ModelId"), model: "worker", parse: modelId("models.worker") },
  {
    key: "models.e2eAgent", description: "the AI model that navigates your app in browser checks: default (Rovara's recommendation) or a model id Rovara can use with your provider",
    target: parameter("runtime", "E2eAgentModelId"), defaultValue: "default", e2eAgentModel: true, parse: e2eAgentModel("models.e2eAgent"),
  },
  {
    key: "models.fallback", description: "the Bedrock model the coding worker, orchestrator and classifier run on when their provider's key secret is missing: none (no fallback; the call fails by name) or a Bedrock model id",
    target: { kind: "stack-parameter", part: "runtime", parameter: "ModelFallback", also: [{ part: "slack", parameter: "ModelFallback" }] }, defaultValue: "none", fallbackModel: true, parse: fallbackModel("models.fallback"),
  },
  {
    key: "models.chatgpt.enabled", description: "true: people may connect their own ChatGPT plan and their tasks run on it; false: every task uses the worker model",
    target: { kind: "chatgpt-setting", field: "enabled" }, defaultValue: "false", parse: oneOf("models.chatgpt.enabled", ["true", "false"]),
  },
  {
    key: "models.chatgpt.preferredModel", description: "the model tasks on a ChatGPT plan prefer, where the person's plan allows it",
    target: { kind: "chatgpt-setting", field: "preferredModel" }, defaultValue: CHATGPT_DEFAULT_PREFERRED_MODEL,
    parse: (value) => (ChatGptModelIdSchema.safeParse(value.trim()).success ? value.trim() : refuse("models.chatgpt.preferredModel", "a model ID such as gpt-6.1-sol")),
  },
  {
    key: "limits.workspacesPerMember", description: "the most workspaces one person may have open",
    target: { kind: "control-plane-setting", field: "perPerson", installDefault: { part: "control-plane", parameter: "SlackMemberWorkspaceLimit" } },
    defaultValue: "3", parse: wholeNumber("limits.workspacesPerMember", 1, 50),
  },
  {
    key: "limits.workspacesPerOrg", description: "the most workspaces the whole organization may have open",
    target: { kind: "control-plane-setting", field: "perOrganization", installDefault: { part: "control-plane", parameter: "SlackOrganizationWorkspaceLimit" } },
    defaultValue: "20", parse: wholeNumber("limits.workspacesPerOrg", 1, 1000),
  },
  { key: "limits.threadTurnsPerMinute", description: "the most requests one Slack thread may start in a minute", target: parameter("control-plane", "SlackThreadTurnsPerMinute"), defaultValue: "6", parse: wholeNumber("limits.threadTurnsPerMinute", 1, 60) },
  { key: "slack.appPostedMessages", description: "accept: answer mentions a person posts through another app; ignore: only typed mentions", target: parameter("control-plane", "SlackAppPostedMessages"), defaultValue: "accept", parse: oneOf("slack.appPostedMessages", ["accept", "ignore"]) },
  { key: "alerts.address", description: "where alarms go: an email address, or a PagerDuty or Opsgenie address (kept secret)", target: { kind: "settings", field: "alertAddress" }, parse: email("alerts.address") },
  { key: "alerts.slowTurnMinutes", description: "a turn slower than this many minutes raises the SlowTurns alarm", target: parameter("slack", "SlowTurnMinutes"), defaultValue: "5", parse: wholeNumber("alerts.slowTurnMinutes", 1, 60) },
  { key: "budget.monthlyUsd", description: "the monthly AWS budget in whole US dollars; 0 for none", target: parameter("control-plane", "BudgetMonthlyUsd"), defaultValue: "0", parse: wholeNumber("budget.monthlyUsd", 0, MAX_BUDGET_USD) },
  { key: "budget.scope", description: "tag: costs tagged agentx:env for this environment; account: the whole account", target: parameter("control-plane", "BudgetScope"), defaultValue: "tag", parse: oneOf("budget.scope", ["tag", "account"]) },
  {
    key: "audit.lock", description: "production: audit records written from now on are locked for 3 years; trial: locked for 1 day. An install can move from trial to production, never back",
    target: parameter("control-plane", "AuditLockProfile"), parse: oneOf("audit.lock", ["production", "trial"]),
  },
  { key: "mcp.confirmElicitation", description: "enabled: an admin may confirm a change from an AI tool in the tool's own pop-up; disabled: only the Slack Confirm button or the CLI", target: parameter("control-plane", "McpConfirmElicitation"), defaultValue: "enabled", parse: oneOf("mcp.confirmElicitation", ["enabled", "disabled"]) },
  { key: "rovaraCode.v2", description: "true: Rovara Code version 2 (Understand, the plan check, parallel parts, merge tracking) is available in this environment and an admin may adopt it; false: every org stays on version 1. Existing tasks keep their version", target: parameter("control-plane", "RovaraCodeV2Enabled"), defaultValue: "false", parse: oneOf("rovaraCode.v2", ["true", "false"]) },
  { key: "planSelfCheck.enabled", description: "true: every coding plan is checked before the owner sees it and the planner is asked again once for a fixable problem (also checks the plan against the current app); false: plans go to the owner as written", target: parameter("control-plane", "PlanSelfCheckEnabled"), defaultValue: "true", parse: oneOf("planSelfCheck.enabled", ["true", "false"]) },
  { key: "autofix.enabled", description: "true: Rovara sends blocked checks or reviews back to coding by itself (before any pull request, within its limits); false: only the owner does", target: parameter("control-plane", "AutofixEnabled"), defaultValue: "true", parse: oneOf("autofix.enabled", ["true", "false"]) },
  { key: "liveSteer.enabled", description: "1: a person's message to a running step is given to it live (turn on only after the dispatcher, publisher, broker and worker image that carry live steer are deployed); 0: every message waits as a note for the next step", target: parameter("control-plane", "LiveSteerEnabled"), defaultValue: "0", parse: oneOf("liveSteer.enabled", ["0", "1"]) },
  { key: "liveRedirect.enabled", description: "1: the task owner (or a co-owner) can stop a running step and redirect it with a new instruction (turn on only after the dispatcher, broker and worker image that carry Stop & redirect are deployed); 0: the redirect route is off", target: parameter("control-plane", "LiveRedirectEnabled"), defaultValue: "0", parse: oneOf("liveRedirect.enabled", ["0", "1"]) },
  { key: "liveAsk.enabled", description: "1: Ask about this task is on (turn on only after the chat service that carries the Ask route is deployed); 0: every Ask route answers not found", target: parameter("control-plane", "LiveAskEnabled"), defaultValue: "0", parse: oneOf("liveAsk.enabled", ["0", "1"]) },
  { key: "liveFix.enabled", description: "1: Fix with agent is on (a person who can use an error's task asks for a diagnosis; it explains and proposes, and changes nothing; turn on only after the chat service that carries the diagnosis route is deployed); 0: every diagnosis route answers not found", target: parameter("control-plane", "LiveFixEnabled"), defaultValue: "0", parse: oneOf("liveFix.enabled", ["0", "1"]) },
  { key: "proofEvidence.enabled", description: "1: the evidence of a task's checks is gathered, kept and shown (a summary and a link on the pull request, an Evidence tab and a download behind sign-in; turn on only after the worker image that carries task.evidenceCapture.v1 is deployed); 0: nothing new is gathered, posted or served", target: parameter("control-plane", "ProofEvidenceEnabled"), defaultValue: "0", parse: oneOf("proofEvidence.enabled", ["0", "1"]) },
  { key: "decisionCards.enabled", description: "1: decision cards are on (the card routes and the Slack card press; medium and high-risk plans are approved in the app; high-risk plans, designs, design review Skips and cost choices and merges are decided on their card after a recent sign-in with the email code (never GitHub); new installs default to 1); 0: the emergency off, no card route exists and the medium and high-risk rules do not apply", target: parameter("control-plane", "DecisionCardsEnabled"), defaultValue: "1", parse: oneOf("decisionCards.enabled", ["0", "1"]) },
  { key: "testEnvironment.enabled", description: "1: the project test environment is on (Rovara proposes it from the default branch, a maintainer proves and approves it, and tasks use it; turn on only after the worker image that carries task.testEnvDetect.v1 and task.testEnvironment.v1 is deployed); 0: nothing about test environments changes", target: parameter("control-plane", "TestEnvironmentEnabled"), defaultValue: "0", parse: oneOf("testEnvironment.enabled", ["0", "1"]) },
  { key: "teamRecord.enabled", description: "1: the Team record is on (sources a project learns from, lessons and search; the first time, this records the choice and the next agentx upgrade builds its storage, which every later upgrade keeps); 0: paused, nothing is read or recorded and the stored record is kept", target: parameter("control-plane", "TeamRecordEnabled"), defaultValue: "0", teamRecord: true, parse: oneOf("teamRecord.enabled", ["0", "1"]) },
  { key: "teamRecord.options", description: "the Team record's storage options, confirmed before it is built and passed to every upgrade: default (Rovara's), or kmsKeyArn=<arn>;lake=true|false;athenaUsers=<arn,arn>;enterpriseWorkspaceId=<id> (Enterprise needs enterpriseWorkspaceId); refused once the record is built", target: { kind: "settings", field: "teamRecordOptions" }, parse: (value) => value.trim() },
  { key: "teamRecord.embedderImage", description: "the self-hosted embedder image the Team record embeds with (environments/embedder): a private ECR image in this account and region pinned by digest (<account>.dkr.ecr.<region>.amazonaws.com/<repository>@sha256:<digest>), (the release names it and agentx upgrade passes it; an upgrade to a release that names none keeps this one; an upgrade to a release that does replaces it); needs the Team record built", target: parameter("control-plane", "EmbedderImageUri"), defaultValue: "none", parse: embedderImage("teamRecord.embedderImage") },
  { key: "learnedLessons.enabled", description: "1: approved lessons are loaded into an agent's prompt as advice (needs the Team record; turn on only after the worker image that carries task.learnedContext.v1 is deployed); 0: no lesson is loaded or sent to an agent, even where the Team record is on", target: parameter("control-plane", "LearnedLessonsEnabled"), defaultValue: "0", parse: oneOf("learnedLessons.enabled", ["0", "1"]) },
  { key: "designReview.enabled", description: "1: fresh-context reviewers check the design of a Full task before a person approves it, but only where a company admin has allowed it and the project's mode is not Off (both are set in How we work); 0: no task has a design review, and a review already under way ends at its next step as not run", target: parameter("control-plane", "DesignReviewEnabled"), defaultValue: "0", parse: oneOf("designReview.enabled", ["0", "1"]) },
  { key: "savedEnv.enabled", description: "1: a project's proven setup can be built into a saved image and used by tasks (turn on only after the registry roles and the worker image are deployed); 0: nothing is built, pushed, pulled or sent to a worker", target: parameter("control-plane", "SavedEnvEnabled"), defaultValue: "0", parse: oneOf("savedEnv.enabled", ["0", "1"]) },
  { key: "slack.explicitMembers", description: "1: a Slack person who is not an explicit, current member of the company (not removed, not banned) is not served in Slack and is told to ask an admin to add them or to link their account (new installs default to 1); warn: today's access is kept and each such person gets one direct message that a membership will soon be needed; 0: today's behaviour, a Slack person with no membership is served as an implicit member (the rollback)", target: parameter("control-plane", "SlackExplicitMembers"), defaultValue: "1", parse: oneOf("slack.explicitMembers", ["0", "1", "warn"]) },
  { key: "ui.forceOff", description: "screens to hold back for every company on this install, whatever a company chose in the app: none, all, or screen names joined by a hyphen (look, nav, home, work, spending, leadingHeader, health, setup, insights, publish, billing, agreement); a name that is not one of these turns every screen off", target: parameter("control-plane", "UiFlagsForceOff"), defaultValue: "none", parse: uiFlagsForceOffValue("ui.forceOff") },
  { key: "scriptTokens.enabled", description: "1: people can make script tokens in the app settings so their scripts and CI can read and start their own tasks; 0: no token can be made and every script token is refused", target: parameter("control-plane", "ScriptTokensEnabled"), defaultValue: "0", parse: oneOf("scriptTokens.enabled", ["0", "1"]) },
  { key: "standingInstructions.enabled", description: "1: the project's How we work reaches every step in the system prompt, in one block with the company's rules and the precedence wording (turn on only after the worker image that carries task.standingInstructions.v1 is deployed); 0: How we work stays in the user message", target: parameter("control-plane", "StandingInstructionsEnabled"), defaultValue: "0", parse: oneOf("standingInstructions.enabled", ["0", "1"]) },
  { key: "secondReview.enabled", description: "1: an added second review of a task's code by a model of a different AI company is on (a project or company chooses shadow, where it never blocks, or on; turn on only after the worker image that runs it is deployed); 0: no second review is planned, run or shown", target: parameter("control-plane", "SecondReviewEnabled"), defaultValue: "0", parse: oneOf("secondReview.enabled", ["0", "1"]) },
  { key: "setupRecipes.enabled", description: "1: approved company setup recipes are offered to a project's setup run as a proposal source (each value a recipe adds is cited as the recipe's and is still proved in a fresh sandbox and confirmed by a person; turn on only after the worker image that reads recipe offers is deployed); 0: no recipe is offered", target: parameter("control-plane", "SetupRecipesEnabled"), defaultValue: "0", parse: oneOf("setupRecipes.enabled", ["0", "1"]) },
  { key: "nightlyHealth.enabled", description: "1: the nightly run sets the project's health (Setup needs repair, a Fix setup card, a banner on new tasks; needs the test environment); 0: no health is recorded or shown", target: parameter("control-plane", "NightlyHealthEnabled"), defaultValue: "0", parse: oneOf("nightlyHealth.enabled", ["0", "1"]) },
  { key: "insights.enabled", description: "1: the Insights reads (stuck work, shipped outcomes, spend, flow) and the viewer grant are on for the install (the Insights screen also needs its own app switch); 0: every Insights path but the overview answers as an unknown path", target: parameter("control-plane", "InsightsEnabled"), defaultValue: "0", parse: oneOf("insights.enabled", ["0", "1"]) },
  { key: "verifyResults.enabled", description: "1: a task and its pull request show one of four test results (Verified, Code failed, Partially verified, Blocked by environment) with a Testing section, and an environment fault opens a Fix setup card; 0: nothing about test results changes", target: parameter("control-plane", "VerifyResultsEnabled"), defaultValue: "0", parse: oneOf("verifyResults.enabled", ["0", "1"]) },
  { key: "setupAgent.enabled", description: "1: Set up this project can start a live setup run that runs commands in a sandbox, with host-ask cards for new websites (turn on only after the five Linux checks of SH-1 pass and the worker image that carries task.setupAgent.v1 is deployed); 0: setup is the read-only draft, the prove run and the confirm card", target: parameter("control-plane", "SetupAgentEnabled"), defaultValue: "0", parse: oneOf("setupAgent.enabled", ["0", "1"]) },
  { key: "testServices.enabled", description: "1: a project's dependencies (databases, caches, queues, AWS services, outside APIs) get a backing for test runs on a sealed per-run network (turn on only after the Linux checks TS-L1 to TS-L6 pass and the worker image that carries the service runner is deployed); 0: today's flow, services are refused as before", target: parameter("control-plane", "TestServicesEnabled"), defaultValue: "0", parse: oneOf("testServices.enabled", ["0", "1"]) },
  { key: "testAccounts.enabled", description: "1: a project may use the customer's own test accounts for a dependency, each approved by a second admin (needs testServices.enabled); 0: no test account is stored, approved or used", target: parameter("control-plane", "TestAccountsEnabled"), defaultValue: "0", parse: oneOf("testAccounts.enabled", ["0", "1"]) },
  { key: "projectImages.enabled", description: "1: a project may bring its own images for a dependency (reviewed compose services, a model image; needs testServices.enabled); 0: only Rovara's image catalog is used", target: parameter("control-plane", "ProjectImagesEnabled"), defaultValue: "0", parse: oneOf("projectImages.enabled", ["0", "1"]) },
  { key: "workflowDependencies.enabled", description: "true: a task can break its work into serial parts inside one task (spec 059: the plan's breakdown is approved, run in order, and a failed part is retried); false: tasks run as one piece, as before. Existing tasks keep working either way", target: parameter("control-plane", "WorkflowDependenciesEnabled"), defaultValue: "false", parse: oneOf("workflowDependencies.enabled", ["true", "false"]) },
  { key: "taskPeople.changesEnabled", description: "true: a task's owner can manage who is on a task (owner, commenter, viewer or denied) and a person can take over an ownerless task; a task person is a current member of the company who may write (not an Auditor), however they sign in (web, GitHub, an identity provider or Slack); a Slack account or channel alone is not a membership, and People lists exist for tasks shared into Slack. Turning it on also creates the task person proof function the dispatcher needs; false: People are not changed and tasks behave as before", target: parameter("control-plane", "TaskPeopleChangesEnabled"), defaultValue: "false", parse: oneOf("taskPeople.changesEnabled", ["true", "false"]) },
  { key: "taskPeople.publicInvitations", description: "false (the only value for now): automatic Slack invitations of a task person to a public task channel are not built yet; they need a Slack reinstall with new scopes", target: parameter("control-plane", "TaskPeoplePublicInvitationsEnabled"), defaultValue: "false", parse: invitationsDeferred("taskPeople.publicInvitations") },
  { key: "taskPeople.privateInvitations", description: "false (the only value for now): automatic Slack invitations of a task person to a private task channel are not built yet; they need a Slack reinstall with new scopes", target: parameter("control-plane", "TaskPeoplePrivateInvitationsEnabled"), defaultValue: "false", parse: invitationsDeferred("taskPeople.privateInvitations") },
];

export function configKey(name: string): ConfigKey {
  const found = CONFIG_KEYS.find((entry) => entry.key === name);
  if (found === undefined) throw agentXError("CONFIG_INVALID", `unknown config key ${name}; agentx config list shows every key`);
  return found;
}

export function whereText(target: ConfigTarget, env: string): string {
  switch (target.kind) {
    case "stack-parameter":
      return `stack parameter ${target.parameter} on ${[target, ...(target.also ?? [])].map((each) => environmentStackName(env, each.part)).join(" and ")}`;
    case "settings":
      return target.field === "teamRecordOptions" ? `SSM ${environmentSettingsPrefix(env)}team-record (options)` : `SSM ${environmentSettingsPrefix(env)}settings (${target.field})`;
    case "control-plane-setting":
      return `control-plane setting WORKSPACE_LIMITS.${target.field} (install-time default ${target.installDefault.parameter})`;
    case "chatgpt-setting":
      return `control-plane setting CHATGPT.${target.field}`;
  }
}
