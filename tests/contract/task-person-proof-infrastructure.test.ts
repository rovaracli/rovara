import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { TASK_PERSON_DEVELOPER_RECORD_PROJECTION } from "@agentx/cloud-contracts";
import { TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES } from "../../packages/broker/src/aws/task-person-runtime.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerNamesIn, brokerSettingsIn, takeBrokerNames, takeBrokerSettings } from "../support/broker-names-template.js";
import { hasModelProxy, withoutModelProxy } from "../support/model-proxy-template.js";
import { hasAuditLedger, withoutAuditLedger } from "../support/audit-ledger-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";

skipLambdaBundling();

type TemplateJson = {
  Parameters?: Record<string, Record<string, unknown>>;
  Conditions?: Record<string, unknown>;
  Resources?: Record<string, { Type: string; Condition?: string; Properties?: Record<string, unknown> }>;
};

function namedTemplate(env: string, account = "944937319445", region = "us-east-1"): TemplateJson {
  const rendered: unknown = Template.fromStack(new ControlPlaneStack(new App(), `Proof-${env}-${account}-${region}`, {
    env: { account, region }, naming: environmentNaming(env),
  })).toJSON();
  return rendered as TemplateJson;
}

/** Evaluates a CloudFormation condition built from Fn::Or, Fn::And, Fn::Not, Fn::Equals, Ref (a parameter) and literals, for the parameter values given. */
function evaluateCondition(node: unknown, values: Record<string, string>): boolean {
  const value = (item: unknown): string | boolean => {
    if (typeof item === "string") return item;
    const record = item as Record<string, unknown>;
    if (typeof record.Ref === "string") {
      if (!(record.Ref in values)) throw new Error(`condition reads ${record.Ref}, which the test does not set`);
      return values[record.Ref]!;
    }
    return evaluateCondition(item, values);
  };
  const record = node as Record<string, unknown[]>;
  if (record["Fn::Equals"] !== undefined) return value(record["Fn::Equals"][0]) === value(record["Fn::Equals"][1]);
  if (record["Fn::Or"] !== undefined) return record["Fn::Or"].some((item) => value(item) === true);
  if (record["Fn::And"] !== undefined) return record["Fn::And"].every((item) => value(item) === true);
  if (record["Fn::Not"] !== undefined) return value(record["Fn::Not"][0]) !== true;
  throw new Error(`unsupported condition ${JSON.stringify(node)}`);
}

function proofEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([logicalId]) => logicalId.includes("TaskPersonProof"));
}

function workflowDependencyEnvironmentEntries(template: TemplateJson) {
  return Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Broker") && resource.Type === "AWS::Lambda::Function");
}

function runtimeCatalogEnvironmentEntries(template: TemplateJson) {
  const brokers = workflowDependencyEnvironmentEntries(template);
  const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
  expect(brokers, "one Broker owns both runtime catalog IDs").toHaveLength(1);
  expect(dispatchers, "one Dispatcher owns the project setup catalog ID").toHaveLength(1);
  const brokerVariables = brokers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  const dispatcherVariables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  return { broker: brokerVariables.Variables, dispatcher: dispatcherVariables.Variables };
}

function expectRuntimeCatalogEnvironment(template: TemplateJson, prefix: string) {
  const { broker, dispatcher } = runtimeCatalogEnvironmentEntries(template);
  const setupId = `${prefix}-project-setup-runtime-v1`;
  const featureId = `${prefix}-e2e-mock-runtime-v1`;
  if (prefix === "agentx-production") {
    // The legacy install's broker is given both whole, as it always was.
    expect(broker.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
    expect(broker.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID).toBe(featureId);
  } else {
    // A named environment's broker derives both from its environment name (the broker's variables are held to Lambda's 4 KB), to the same ids.
    expect(broker).not.toHaveProperty("AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID");
    expect(broker).not.toHaveProperty("AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID");
    const derived: MutableEnvironment = { AGENTX_ENV: prefix.replace(/^agentx-/, ""), AGENTX_NAMES: "{}", AWS_REGION: "us-east-1", AGENTX_ACCOUNT_ID: "123456789012" };
    hydrateBrokerEnvironment(derived);
    expect(derived.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
    expect(derived.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID).toBe(featureId);
  }
  expect(dispatcher.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID).toBe(setupId);
  expect(dispatcher).not.toHaveProperty("AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID");
}

function appControlPlane(env: string): TemplateJson {
  const stacks = buildAgentXApp({ agentxEnv: env }).node.children.filter((child): child is Stack => Stack.isStack(child));
  const stack = stacks.find((candidate) => candidate.stackName === `agentx-${env}-control-plane`);
  if (stack === undefined) throw new Error(`expected the real ${env} control-plane stack`);
  return Template.fromStack(stack).toJSON();
}

function parentRemainderDigest(template: TemplateJson): string {
  const remainder = structuredClone(template);
  // The model proxy (Task 10) is no part of the proof-only addition; take it out the way named-templates does.
  if (hasModelProxy(remainder)) withoutModelProxy(remainder);
  // The Audit Ledger (Task 5) is likewise no part of the proof-only addition.
  if (hasAuditLedger(remainder)) withoutAuditLedger(remainder);
  delete remainder.Parameters?.TaskPersonProofEnabled;
  // Spec 059's default-OFF runtime graph addition is asserted exactly below; exclude only that
  // named parameter and its corresponding Broker environment reference from the proof-only hash.
  delete remainder.Parameters?.WorkflowDependenciesEnabled;
  // Rovara Code v2 per environment (Plan 6): its parameter and its packed setting are no part of the proof-only addition either.
  delete remainder.Parameters?.RovaraCodeV2Enabled;
  // Mainline #408 kill switches (plan self-check, automatic fixing): parameters and packed settings, no part of the proof-only addition.
  delete remainder.Parameters?.PlanSelfCheckEnabled;
  delete remainder.Parameters?.LearningSuggestionsDefault;
  // Lane U5 (runtime UI flags): the operator's override, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.UiFlagsForceOff;
  delete remainder.Parameters?.AutofixEnabled;
  // Live steer kill switch: a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.LiveSteerEnabled;
  delete remainder.Parameters?.LiveRedirectEnabled;
  // Live interaction A3: the Ask switch, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.LiveAskEnabled;
  // Live interaction F2 to F4: the Fix with agent switch, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.LiveFixEnabled;
  // Proof and evidence, and decision cards (wire-proof): two switches, parameters and packed settings, no part of the proof-only addition.
  delete remainder.Parameters?.ProofEvidenceEnabled;
  delete remainder.Parameters?.DecisionCardsEnabled;
  // Test environment (wire-testenv): one switch, a parameter and a packed setting.
  delete remainder.Parameters?.TestEnvironmentEnabled;
  // Lessons reach the agent: its own switch, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.LearnedLessonsEnabled;
  // Second review by a different AI company (SH34): one switch, a parameter and a packed setting.
  delete remainder.Parameters?.SecondReviewEnabled;
  // Company setup recipes (SH30): one switch, a parameter and a packed setting.
  delete remainder.Parameters?.SetupRecipesEnabled;
  delete remainder.Parameters?.NightlyHealthEnabled;
  delete remainder.Parameters?.InsightsEnabled;
  // Four test results: its own switch, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.VerifyResultsEnabled;
  // Setup agent (sh-setup-wire): its own switch, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.SetupAgentEnabled;
  delete remainder.Parameters?.SavedEnvEnabled;
  delete remainder.Parameters?.ScriptTokensEnabled;
  delete remainder.Parameters?.SlackExplicitMembers;
  delete remainder.Parameters?.StandingInstructionsEnabled;
  // Test services (TS37): three switches, parameters and packed settings, no part of the proof-only addition.
  delete remainder.Parameters?.TestServicesEnabled;
  delete remainder.Parameters?.TestAccountsEnabled;
  delete remainder.Parameters?.ProjectImagesEnabled;
  const conditions = remainder.Conditions ?? {};
  for (const id of Object.keys(conditions)) if (id.includes("InstallTaskPersonProof")) delete conditions[id];
  const resources = remainder.Resources ?? {};
  for (const id of Object.keys(resources)) if (id.startsWith("TaskPersonProof")) delete resources[id];
  // (2026-11-03: the Rovara-paid diagnosis ceiling's parameter, packed setting, metric filter and alarm were removed; nothing of them is left to take out here, and the pinned digests below did not move.)
  // Plan 3 Task 30's spend settlement schedule is no part of the proof-only addition either.
  const spendSchedules = Object.keys(resources).filter((id) => id.startsWith("SpendSettlementSchedule"));
  // Named environments have the one schedule (spend-ledger.test.ts asserts it) and the legacy template has none; nothing else may hide under the prefix.
  expect(spendSchedules.length, "at most the one spend settlement schedule is taken out").toBeLessThanOrEqual(1);
  for (const id of spendSchedules) delete resources[id];
  // Plan 4 Task 9's chain sweep schedule is no part of the proof-only addition either (named-templates.test.ts asserts it).
  const chainSweepSchedules = Object.keys(resources).filter((id) => id.startsWith("ChainSweepSchedule"));
  expect(chainSweepSchedules.length, "at most the one chain sweep schedule is taken out").toBeLessThanOrEqual(1);
  for (const id of chainSweepSchedules) delete resources[id];
  // Plan 3 Task 11's one statement (PutItem on the MEMBER_MERGE_QUEUE partition, for the sign-in function) is no part of the proof-only addition either.
  const mergeMarkerGrants = Object.values(resources).flatMap((resource) => {
    if (resource.Type !== "AWS::IAM::Policy") return [];
    const document = (resource.Properties as { PolicyDocument?: { Statement?: unknown[] } } | undefined)?.PolicyDocument;
    const kept = (document?.Statement ?? []).filter((statement) => !JSON.stringify((statement as { Condition?: unknown }).Condition ?? {}).includes("MEMBER_MERGE_QUEUE"));
    const removed = (document?.Statement ?? []).length - kept.length;
    if (document?.Statement !== undefined) document.Statement = kept;
    return removed > 0 ? [removed] : [];
  });
  expect(mergeMarkerGrants.reduce((total, removed) => total + removed, 0), "at most the one merge marker statement is taken out").toBeLessThanOrEqual(1);
  const dispatchers = Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
  expect(dispatchers, "the actual Dispatcher remains in the parent template remainder").toHaveLength(1);
  const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
  delete variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN;
  delete variables.Variables.SLACK_TEAM_ID;
  delete variables.Variables.DEVELOPER_SIGNIN_TABLE_NAME;
  for (const [id] of workflowDependencyEnvironmentEntries(remainder)) {
    const brokerVariables = resources[id]!.Properties!.Environment as { Variables: Record<string, unknown> };
    // The flag is in the broker's settings in a named environment (ENV-ROOM: AGENTX_SETTINGS), and its own variable in the legacy one (which has none).
    if (brokerVariables.Variables.AGENTX_SETTINGS !== undefined) takeBrokerSettings(brokerVariables.Variables, ["workflowDependencies", "rovaraCodeV2", "planSelfCheck", "autofix", "liveSteer", "liveRedirect", "liveAsk", "liveFix", "proofEvidence", "decisionCards", "testEnvironment", "learnedLessons", "verifyResults", "setupAgent", "testServices", "testAccounts", "projectImages", "secondReview", "setupRecipes", "nightlyHealth", "insights", "learningSuggestionsDefault", "uiFlagsForceOff"]);
    delete brokerVariables.Variables.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED;
    delete brokerVariables.Variables.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
    delete brokerVariables.Variables.AGENTX_E2E_FEATURE_RUNTIME_CATALOG_ID;
    // Task 23 (ruling R55): where a cloud org's projects run. A named environment's control plane only; it is no part of the proof addition.
    if (brokerVariables.Variables.AGENTX_NAMES !== undefined) takeBrokerNames(brokerVariables.Variables, ["launchTemplate"]);
    delete brokerVariables.Variables.EC2_WORKER_LAUNCH_TEMPLATE_ID;
    delete brokerVariables.Variables.EC2_WORKER_SUBNETS;
  }
  delete remainder.Parameters?.Ec2WorkerSubnets;
  for (const [, resource] of Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function")) {
    const dispatcherVariables = resource.Properties!.Environment as { Variables: Record<string, unknown> };
    delete dispatcherVariables.Variables.AGENTX_PROJECT_SETUP_RUNTIME_CATALOG_ID;
  }
  // This separately tested, least-privilege creator fence is the only additional sign-in-table
  // statement. Remove only its exact action/resource pair so historical parent hashes stay scoped.
  for (const entry of developerSignInConditionCheckEntries(remainder)) {
    const policy = resources[entry.policyId]!;
    const document = policy.Properties!.PolicyDocument as { Statement: unknown };
    if (Array.isArray(document.Statement)) document.Statement.splice(entry.index, 1);
    else delete (document as { Statement?: unknown }).Statement;
  }
  const establishedAssetHashNormalization = JSON.stringify(remainder).replace(/[a-f0-9]{64}/g, "<asset-hash>");
  return createHash("sha256").update(establishedAssetHashNormalization).digest("hex");
}

function realAppControlPlane(env?: string): TemplateJson {
  const app = buildAgentXApp(env === undefined ? {} : { agentxEnv: env });
  const stacks = app.node.children.filter((child): child is Stack => Stack.isStack(child));
  const stackName = env === undefined ? "AgentXControlPlane" : `agentx-${env}-control-plane`;
  const stack = stacks.find((candidate) => candidate.stackName === stackName);
  if (stack === undefined) throw new Error(`expected actual app control-plane stack ${stackName}`);
  return Template.fromStack(stack).toJSON();
}

function normalizeSingleton(value: unknown): unknown {
  // CDK may emit one IAM Action/Resource as a scalar or a singleton array; normalize only that shape.
  return Array.isArray(value) && value.length === 1 ? value[0] : value;
}

function developerSignInConditionCheckEntries(template: TemplateJson): Array<{ policyId: string; index: number; statement: Record<string, unknown>; tableId: string }> {
  const resources = template.Resources ?? {};
  const signInTable = Object.entries(resources).find(([id, resource]) => id.startsWith("DeveloperSignInTable") && resource.Type === "AWS::DynamoDB::Table");
  const brokerRole = Object.entries(resources).find(([id, resource]) => id.startsWith("BrokerServiceRole") && resource.Type === "AWS::IAM::Role");
  if (signInTable === undefined || brokerRole === undefined) return [];
  const [tableId] = signInTable;
  const roleId = brokerRole[0];
  const expectedResource = { "Fn::GetAtt": [tableId, "Arn"] };
  const entries: Array<{ policyId: string; index: number; statement: Record<string, unknown>; tableId: string }> = [];
  for (const [policyId, resource] of Object.entries(resources)) {
    if (resource.Type !== "AWS::IAM::Policy" && resource.Type !== "AWS::IAM::ManagedPolicy") continue; // the broker's named managed grant policies count (ruling M2)
    const properties = resource.Properties as { Roles?: unknown; PolicyDocument?: { Statement?: unknown } } | undefined;
    const roles = Array.isArray(properties?.Roles) ? properties.Roles as Array<Record<string, unknown>> : [];
    if (!roles.some((role) => role.Ref === roleId)) continue;
    const rawStatements = properties?.PolicyDocument?.Statement;
    const statements = Array.isArray(rawStatements) ? rawStatements : rawStatements === undefined ? [] : [rawStatements];
    statements.forEach((value, index) => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return;
      const statement = value as Record<string, unknown>;
      if (normalizeSingleton(statement.Action) === "dynamodb:ConditionCheckItem"
        && JSON.stringify(statement.Resource) === JSON.stringify(expectedResource)) {
        entries.push({ policyId, index, statement, tableId });
      }
    });
  }
  return entries;
}

describe("the named TEST proof-only installation gate", () => {
  it("declares a distinct default-OFF gate in every named environment, and none in the legacy deployment", () => {
    const livetest = namedTemplate("agentxlivetest123");
    const staging = namedTemplate("staging", "123456789012", "us-west-2");
    const otherAccount = namedTemplate("agentxlivetest123", "123456789012");
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "Legacy")).toJSON() as TemplateJson;

    for (const [label, template] of [["livetest", livetest], ["staging", staging], ["other account", otherAccount]] as const) {
      expect(template.Parameters?.TaskPersonProofEnabled, `${label} declares the gate`).toMatchObject({ Type: "String", Default: "false", AllowedValues: ["true", "false"] });
      expect(proofEntries(template).length, `${label} has the proof resources`).toBeGreaterThan(0);
      expect(template.Parameters?.TaskPeopleChangesEnabled, label).toMatchObject({ Default: "false" });
      expect(template.Parameters?.TaskPeoplePublicInvitationsEnabled, label).toMatchObject({ Default: "false" });
      expect(template.Parameters?.TaskPeoplePrivateInvitationsEnabled, label).toMatchObject({ Default: "false" });
    }
    expect(legacy.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(legacy)).toHaveLength(0);
  });

  it("preserves exact parent app templates outside the named proof addition", () => {
    const named = realAppControlPlane("agentxlivetest123");
    const foreign = realAppControlPlane("staging");
    const legacy = realAppControlPlane();
    expectRuntimeCatalogEnvironment(named, "agentx-agentxlivetest123");
    expectRuntimeCatalogEnvironment(foreign, "agentx-staging");
    expectRuntimeCatalogEnvironment(legacy, "agentx-production");

    // The legacy deployment has none of it. Every named environment (staging among them) has the proof, off until a switch is on: the dispatcher's three variables are there and empty
    // while neither switch is "true" (the condition decides, see the truth table below).
    expect(legacy.Parameters?.TaskPersonProofEnabled, "legacy has no proof-only parameter").toBeUndefined();
    expect(proofEntries(legacy), "legacy has no proof-only resources").toHaveLength(0);
    for (const [label, template] of [["staging", foreign], ["legacy", legacy]] as const) {
      const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
      expect(dispatchers, `${label} has its ordinary Dispatcher`).toHaveLength(1);
      const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
        if (label === "legacy") expect(variables.Variables, `legacy has no proof-only ${key}`).not.toHaveProperty(key);
        else expect(JSON.stringify(variables.Variables[key]), `staging's ${key} is empty unless the proof is installed`).toContain("InstallTaskPersonProof");
      }
    }
    expect(foreign.Parameters?.TaskPersonProofEnabled, "staging declares the gate").toMatchObject({ Default: "false" });
    expect(proofEntries(foreign).length, "staging has the proof resources").toBeGreaterThan(0);

    for (const [label, template] of [["named", named], ["foreign", foreign]] as const) {
      expect(template.Parameters?.WorkflowDependenciesEnabled, `${label} preserves the default-OFF workflow gate`).toMatchObject({
        Type: "String", Default: "false", AllowedValues: ["true", "false"],
      });
      const broker = workflowDependencyEnvironmentEntries(template);
      expect(broker, `${label} has exactly one Broker with the workflow flag`).toHaveLength(1);
      const variables = broker[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      expect(brokerSettingsIn(variables.Variables).workflowDependencies, `${label} wires only the parameter reference`).toEqual({ Ref: "WorkflowDependenciesEnabled" });
      expect(variables.Variables, `${label} has it in the broker's settings, not as a variable of its own`).not.toHaveProperty("AGENTX_WORKFLOW_DEPENDENCIES_ENABLED");
    }
    expect(legacy.Parameters?.WorkflowDependenciesEnabled, "legacy has no workflow gate parameter").toBeUndefined();
    const legacyBrokers = workflowDependencyEnvironmentEntries(legacy);
    expect(legacyBrokers, "legacy has its Broker Lambda").toHaveLength(1);
    const legacyVariables = legacyBrokers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
    expect(legacyVariables.Variables.AGENTX_WORKFLOW_DEPENDENCIES_ENABLED, "legacy has no workflow flag").toBeUndefined();

    // Plan 2 Task 14 (merge 3): the legacy template gains the GitHub install-request reminder schedule and its notice-failed metric filter
    // (legacy-templates snapshot, +45 lines, additions only), so the legacy digests moved with them; the legacy broker policy is unchanged.
    // Plan 3, Task 22: the notifier's stream filter also takes AGENT_REPORT_POST items (one more value in an existing filter), so the named and foreign
    // digests moved with it; the legacy template has no notifier and is unchanged.
    // Plan 5, Task 5: the sign-in stack's `ANY /s/{proxy+}` route (a session's link) moved the named and foreign digests; legacy has no sign-in stack.
    // Plan 3 final fix wave (review C1): a named environment's broker is given its generated names in one variable (AGENTX_NAMES), not whole, and derives
    // what its environment name decides, so Lambda's 4 KB limit on its variables holds; the named and foreign digests moved with it (the broker's
    // variables only, and the connector secrets role's one Deny); the legacy digests did not move, which is the check that its broker is untouched.
    // Plan 4 Task 19: a named environment's API gains the public event-hook route (`POST /v1/hooks/{source}/{hookId}`, no authorizer, the broker verifies every delivery), so the
    // named and foreign digests moved with it. They had also drifted from the earlier Plan 4 tasks' broker and role changes (the merge of plan 3, BROKER_ROLE_ARN in AGENTX_NAMES, the
    // fixed role names), which no task had re-pinned: all four are taken from the synthesized templates now. The legacy digests did not move: its template has no such route.
    // Task 19 review fix: the route also has its own stage throttle (`RouteSettings`, 100 burst and 50 a second) and the stage waits for it, so the named and foreign digests were taken again from
    // the synthesized templates; the legacy digests are unchanged.
    // Plan 4 Task 26: a named environment's control plane gains the schedule group, the scheduler's invoke role (fixed name), the dead-letter queue and the broker's three
    // statements (manage the group's schedules, pass that one role, drain the queue), so the named and foreign digests were taken again from the synthesized templates; the
    // legacy digests did not move (nothing is added without an environment name), and the broker's variables did not grow (the names are derived from AGENTX_ENV).
    // Plan 4 Task 26 review fixes: the broker's one queue statement now also parks and records (SendMessage, ChangeMessageVisibility, renamed UseChainScheduleDeadLetters) and the queue's age
    // has an alarm, so the named and foreign digests were taken again from the synthesized templates; the legacy digests did not move.
    // Task 27 review I-1: that alarm counts visible plus in-flight messages over three periods (the age metric stops at three receives); named and foreign were taken again, legacy did not move.
    // Merge of Plan 2's final fix wave into Plan 3: the install-request reminder schedule and metric filter are now created on cloud installs only, so the
    // legacy template lost them again and its digests are back to their values before Plan 2 (the legacy-templates snapshot lost the same 45 lines); the
    // named and foreign digests were regenerated for the merged template (Plan 2's cloud-only schedule and the reconciler's StartExecution grant on top of Plan 3).
    // Merge of Plan 3 into Plan 5: the named and foreign digests were regenerated again for the merged template (Plan 5's `ANY /s/{proxy+}` route on top of the above).
    // Plan 5, Task 8: the realtime events API (its API, namespace, authorizer, the authorizer's and publishers' grants, the token key's split deny and the broker's one more
    // name) moved the named and foreign digests; the legacy template has no sign-in stack and none of it, and its digests did not move.
    // Merge of Plans 4 and 5 (chains-sessions-merge): the named and foreign digests were taken again from the synthesized merged template (Plan 4's schedule group, queue and roles beside Plan 5's
    // realtime API and session routes, and the fixed-name roles' lookup grant); the legacy digests did not move.
    // ENV-ROOM (the broker's environment room): the named and foreign digests were taken again from the synthesized templates. The broker's variables moved: the State table, the artifact
    // bucket, the launch template, the allow list and the model proxy joined AGENTX_NAMES, the audit queue's URL is derived, and eleven constrained parameters joined AGENTX_SETTINGS
    // (the workflow flag and the launch template stay out of the hash, as before). The legacy digests did not move: its broker is given its variables whole.
    // ENV-ROOM review fix: the named and foreign digests were taken again after Ec2WorkerLaunchTemplateId gained its AllowedPattern (named environments only); the legacy digests did not move.
    // Plan 5, Task 20: the notifier's role gained two statements (put the session binding and surface items, check the session record), so the named and foreign digests were taken again; legacy has no notifier and did not move.
    // Staging 0.4.3 fix: the broker's `rt` name is the DNS prefix of the events API's HTTP host (Fn::Select of Fn::Split of Dns.Http), not the API's id, so the named and foreign digests were taken again; legacy did not move.
    // Round 5 merge (Tasks 17, 21 and the staging 0.4.3 fixes onto the chains-sessions merge): the named and foreign digests were retaken from the test's output; legacy did not move.
    // Staging 0.4.5 fix: a named environment's API gains `GET /v1/internal/agent-tools` and `GET /v1/internal/agent-skills` (AgentToolsListRoute, AgentSkillsReadRoute, no authorizer; the broker
    // verifies the callback capability), so the named and foreign digests were retaken from the test's output; the legacy digests did not move (named environments only).
    // M3: regenerated named/foreign pins from the merged template; web routes and chain hook throttles coexist. Legacy unchanged.
    // Round 8 merge (staging v046 fixes and the web app Part A onto the chains-sessions merge): the named and foreign digests were retaken from the test's output; legacy did not move.
    // Round 8 release-path fixes: the web app's ResponseHeadersPolicy and OriginAccessControl got explicit prefixed names, so the named and foreign digests were retaken from the test's output; legacy did not move.
    // Staging v0.4.9: the invalid `GET /app/` web route (an empty path segment, refused by API Gateway) was removed with its Lambda permission, so the named and foreign digests were retaken from the test's output; legacy did not move.
    // Round 11 (mainline #408 sync): the notifier's role gained the WORKFLOW_DISPATCH read (blocked cards are no longer lost, LIVEFIX-1); the named and foreign digests were retaken from the test's output, legacy did not move.
    // Round 13b (mainline #409, AUTOREQUALIFY and DRYMSG): the pinned worker AMI (a read grant and a state machine step), the reconciler's pin variable, the pin alarm; the named and foreign digests were retaken from the test's output, legacy did not move (its pins are #409's own, taken as merged).
    // 2026-10-31, cloud/next: the named and foreign digests were retaken after three intended additions to the named control plane (compared against cloud/integration's template: nothing else moved): the evidence lifecycle rules
    // (ExpireEvidenceShort and ExpireEvidenceStd on the artifact bucket, proof and evidence P6), the intake poll schedule (IntakePollSchedule, meta repo lane F), and the gateway route for GET /v1/internal/context-tools
    // (ContextToolsListRoute, meta repo lane E). The legacy digests did not move (named environments only).
    // 2026-11-01, cloud/next after the enterprise lanes: the named and foreign digests were retaken after two intended additions, checked by synthesizing the template at the previous pin
    // (01eabca8b) and now and comparing the parent remainders (asset hashes aside, nothing else moved): the `ReadEditionRecord` statement (ssm:GetParameter on the install's edition record and
    // its backup) on the broker's policy and on the sign-in function's policy (Enterprise foundations I-2, `grantEditionRecordRead`), and `SPEC_STATE` in the notifier's stream filter (wire lane D).
    // The legacy digests did not move (named environments only), which is the check that its template is untouched.
    // 2026-11-02, cloud/next after the switch-on fix lanes: all six digests were retaken. Compared against 5a519496e (which reproduces the old pins), the parent remainders differ only by:
    // `dp` in the broker's AGENTX_NAMES (live-fixes LA-1), DISPATCH_QUEUE_ARN on the dispatcher (live-fixes S2: only its own queue's SQS events are accepted), LEARNED_LESSONS_ENABLED on the
    // dispatcher (lessons-fixes WL-6 S1), and the provisioner state machine recording worker features on markReady (live-fixes LR-1). Legacy moved too, deliberately: the dispatcher queue check and the
    // worker-features record apply to every install. Controller 37 accepted the legacy move.
    // 2026-11-02, saved-env-build (SH22 and its review fixes): the four named and foreign digests were retaken after the saved environment images were added to the named control plane (legacy did not move): the key,
    // the repository creation template, four roles (push, pull and manage, which the broker assumes with a one-repository session policy, and the fixed-name role ECR assumes to create a repository) and their
    // policies, and one broker statement (AssumeSavedEnvImageRoles). The registry-wide scan setting is NOT created by default. SH25 added the SavedEnvEnabled parameter and its packed `sv` setting (the parameter is taken out of the remainder like the other switches). The lifecycle count backstop is keep + 3. Nothing else in the control plane moved.
    // 2026-11-02, merge of cloud/next abde6ff3b into feat/saved-env-build: the four named and foreign digests were retaken again for the two sets of additions together (cloud/next's own and the saved environment images); legacy did not move.
    // 2026-11-02, NH-1 (nightly run): the named and foreign digests were retaken after ONE intended addition to the artifact bucket (checked by synthesizing with and without it: nothing else moved): the lifecycle
    // rule `ExpireNightlyMaps` (prefix nightly-maps/, 30 days). The legacy digests did not move (named environments only).
    // 2026-11-02, merge of cloud/next abde6ff3b into feat/nightly-run: the named and foreign digests were retaken again. cloud/next's own pins (4eb11f80... named, 7831380a... foreign) no longer matched its template after
    // the notifier change in TE-4 (c16c4db50, which retook the named-templates snapshot but not these); the digests now include that change and the ExpireNightlyMaps rule above. Legacy did not move.
    // 2026-11-02, merge of cloud/next 3488a7a48 into feat/saved-env-build: the four named and foreign digests were retaken for the nightly run's artifact bucket rule and the saved environment images together. Legacy did not move.
    // 2026-11-02, merge of feat/cr-settings (cee08fdcb) into cloud/next: the named and foreign digests were retaken after ONE intended addition, checked by synthesizing the parent remainders at 3488a7a48 and with the merge and
    // diffing them (nothing else differs): `SECOND_REVIEW_ENABLED` (Ref SecondReviewEnabled), a plain variable on the OutboxPublisher function. The legacy digests did not move (named environments only).
    // 2026-11-02, merge of cloud/next fde551404 into feat/saved-env-build: the four named and foreign digests were retaken for cloud/next's SecondReviewEnabled variable and the saved environment images together. Legacy did not move.
    // 2026-11-02, feat/saved-env-wire: the four named and foreign digests were retaken for TWO intended additions (the legacy digests did not move; named environments only): the broker's AGENTX_NAMES gains `sk` (the saved
    // environment images key's id: Ref SavedEnvImagesImagesKey...), and the Dispatcher function gains the plain variable SAVED_ENV_ENABLED (Ref SavedEnvEnabled), which it honours when it hands a rebuild job's lease to the worker.
    // 2026-11-03, staging 0.5.0 fix (ECR CustomRoleArn takes no IAM path): the four named and foreign digests were retaken after ONE intended change, the same one the named-templates snapshot shows (nothing else moved): the saved
    // environment images' creation role sits at the root path ("/") instead of /agentx/<env>/, and the deploy role and the boundary name that one role ARN (IamRoles, IamRequireBoundary, IamKeepBoundary, PassRoles) and no longer list it in the
    // fixed-name lookup statement. The legacy digests did not move (named environments only).
    // 2026-11-03, feat/saved-env-wire (SV-2): the four named and foreign digests were retaken after ONE intended change to the saved environment images key policy (the legacy digests did not move; named environments only):
    // the creation role's single allow statement (CreateGrant and DescribeKey under a GrantIsForAWSResource condition, which a DescribeKey request never matches) became two, CreationRoleGrantForEcr (CreateGrant, both
    // conditions) and CreationRoleDescribeForEcr (DescribeKey, ViaService ecr only). DenyOtherGrants did not change. The named-templates snapshot shows the same single change.
    // 2026-11-03, merge of feat/saved-env-wire onto the integration head (which has the root-path creation role and the system-owner/diagnosis-spend additions): the four named and foreign digests below were retaken once for the merged
    // template, from the values the digest test itself reports (nothing hand-computed). The legacy digests did not move.
    // 2026-11-03, merge of the test-services chain (ts-fakes to ts-repack, with ts-images' service catalog image repositories and their key) onto saved-env-wire and ts-run-network: the four named and foreign digests were
    // retaken from the values the digest test itself reports for the merged template (nothing hand-computed); the named-templates snapshot merged cleanly and matches. The legacy digests did not move.
    // 2026-11-02, TS26 (test accounts, lane ts-accounts): the named and foreign digests were retaken after ONE intended IAM addition to the named control plane (legacy did not move): the TestAccountSecretsRole (fixed name
    // agentx-<env>-connector-secrets-test-accounts, trust and permissions in infra/lib/test-account-secrets-policy.ts), the broker's AssumeTestAccountSecretsRole statement, and the access stack's boundary and deploy-role
    // lookups naming it (the boundary through the one `connector-secrets*` ARN, so it did not grow).
    // 2026-11-03, ts-accounts review fixes (Opus review of bc5719055): the named and foreign digests were retaken after ONE intended IAM change to the named control plane (legacy did not move): the TestAccountSecretsRole's
    // permissions gained `secretsmanager:UpdateSecretVersionStage` (the store purpose only, same org and use tags; denied to resolve) for rotation's pending-then-promote. No role was added, so the boundary did not change.
    // 2026-11-03, merge of lane ts-accounts onto the test-services chain (ts-images-on-next-v2, b638814f5): the four named and foreign digests were retaken from the values the digest test itself reports for the merged template
    // (nothing hand-computed); the only template additions are ts-accounts' TestAccountSecretsRole, the broker's AssumeTestAccountSecretsRole statement and the lookup ARN. The legacy digests did not move.
    // 2026-11-03, integration tip fixes (ENV-ROOM): the four named and foreign digests were retaken once more, from the values the digest test itself reports. The broker's GITHUB_APP_CREDENTIAL_REF, GITHUB_APP_ID and WEB_FEATURES
    // variables and (cloud) DEVELOPER_GITHUB_CLIENT_ID moved into AGENTX_SETTINGS to win back its 400 bytes of room, and those parameters gained a plain-text AllowedPattern in a named environment. The legacy digests did not move.
    // 2026-11-04, 0.5.3 integration (4241fd159: test-services slice 2 plus design review on top of slice 1): the four named and foreign digests were retaken from the values the digest test itself reports (nothing hand-computed); each lane had retaken them on its own base, and the merge holds both additions. The legacy digests did not move.
    // 2026-11-04, merge of cloud/next cf34811c6 (env packing, usable models) with the test-services chain and lane ts-accounts: the named and foreign digests were retaken from the values the digest test itself reports for the merged
    // template (nothing hand-computed). The legacy digests did not move.
    // 2026-11-03, usable models: the four named and foreign digests were retaken after ONE intended addition (the legacy digests did not move; named environments only): the broker's role gained
    // bedrock:GetFoundationModelAvailability on Resource "*" (merged into the statement that already allows xray:PutTraceSegments and xray:PutTelemetryRecords), which the named-templates snapshot shows too.
    // 2026-11-03, merge of lane ts-accounts (df8703c51) onto cf34811c6: the four named and foreign digests were retaken from the values the digest test itself reports (nothing hand-computed); the only template additions are
    // ts-accounts' TestAccountSecretsRole, the broker's AssumeTestAccountSecretsRole statement and the lookup ARN. TEST_ACCOUNT_SECRETS_ROLE_ARN is derived in the process, so AGENTX_SETTINGS did not change. Legacy did not move.
    // 2026-11-03 (s3-fakes-store): the named and foreign digests moved for the control plane's FixtureKey (a retained KMS key and the broker's kms:GenerateDataKey and kms:Decrypt on it). Legacy is unchanged.
    // 2026-11-03 (s3-integration, M4 and the key condition): retaken again from the values the test reports: the key has the alias alias/agentx/<env>/fixtures, the broker's grant carries kms:ViaService = s3.<region>.amazonaws.com, and the `fk` name is gone (the broker builds the alias ARN from AGENTX_ENV). Legacy did not move.
    // 2026-11-04, 0.5.5 integration (f797f3d68: s1-staging-pin-2 + s3-integration-054 + the rest): the named and foreign digests were retaken from the values the digest test itself reports (nothing hand-computed). The control plane's template gained, from the staging pin lane, the session steps' TEST_SERVICES_ENABLED value (see the named-templates snapshot), on top of the FixtureKey and its broker grant recorded above. The legacy digests did not move.
    // 2026-11-05, 0.5.7 integration (integ/057): the named and foreign digests were retaken from the values the digest test itself reports, after ONE intended change (the legacy digests did not move; the optional custom domain adds
    // nothing to a template that sets none): DR-FU4 part 2 removed the retired design review project list, so the DesignReviewProjects parameter and the `dp` entry of the broker's packed AGENTX_SETTINGS are gone. The named-templates
    // snapshot (the whole staging control-plane template, which the foreign case is) shows exactly those two removals and nothing else.
    // 2026-11-07 (UX5b script tokens): the named and foreign digests were retaken from the values the test reports, after one intended change: the `pt` entry of the broker's packed AGENTX_SETTINGS
    // (the ScriptTokensEnabled parameter itself is taken out of the remainder like the other switches). Legacy did not move.
    // Retaken again from the test's own values after the rebase onto integ/0510 at 44030261c (ux1, ux6a, ux5, ux4a merged); the named-templates snapshot differs from that head only by `pt`. Legacy did not move.
    // 2026-11-07 (UX2 slice 2 notifications): the named and foreign digests were retaken from the values the test reports, after one intended change: the DeveloperTaskNotifier's stream filter also passes
    // TASK_ATTENTION_DM rows (the named-templates snapshot shows exactly that string). Legacy did not move.
    // 0.5.11 (QA6-12b): the named and foreign digests were retaken after one intended change: the DeveloperTaskNotifier gains two read-only grants (GetItem on ORG#org_*#SETTINGS, Query on ORG#org_*#RUN_COST#*) for the plan's run limit.
    // Checked first: with the notifier's infra file as it was before, all three infra tests pass, so the change is that statement and nothing else. Legacy did not move.
    // p1-slack-decide-card: the named and foreign digests were retaken after one intended change: the DeveloperTaskNotifier's Lambda gains the variable DECISION_CARDS_ENABLED (Ref DecisionCardsEnabled), no IAM change.
    // Checked first: with the two infra files as they were before, this test passes; legacy did not move.
    // integ/0511 merge: the named and foreign digests were retaken from the values the test reports, after the lanes' intended infra changes were merged together: p1-slack-link-atomic's ConditionCheckItem on DEVELOPER#* for the sign-in
    // function and DEVELOPER_ORG#* for the broker, and p1-runlimit-ack's read-only notifier grants (already recorded above). The named-templates snapshot shows exactly those statements. Legacy did not move.
    // 2026-11-09 (lane I1, standing instructions): the named and foreign digests were retaken from the values the test reports, after one intended change: the `si` entry of the broker\'s packed AGENTX_SETTINGS
    // (the StandingInstructionsEnabled parameter itself is taken out of the remainder like the other switches). The named-templates snapshot shows exactly that parameter and that entry. Legacy did not move.
    // 2026-11-09, integ/0512 merge of I1+I2 onto fix/0512-small: the four named and foreign digests were retaken from the values the test reports, after ONE intended change the fix lane had not re-pinned:
    // the sign-in function's two ConditionCheckItem statements gain `Null: { dynamodb:LeadingKeys: false }`. Checked first: with only those two lines undone, all five tests pass on the lane's pins. Legacy did not move.
    // 2026-11-11 (0.5.14, lane U2, Slack explicit membership): the named and foreign digests were retaken from the values the test reports, after one intended change: the `sm` entry of the broker's packed
    // AGENTX_SETTINGS (the SlackExplicitMembers parameter itself is taken out of the remainder like the other switches). The named-templates snapshot shows exactly that parameter and that entry. Legacy did not move.
    // 2026-11-11 (0.5.15, lane company-images-worker-v3, merged at 029dc304b): the named and foreign digests were retaken from the values the test reports, after the lane's reviewed additions: the CompanyImageMirror function (own role, mirror state rows only), its img-mirror role (ECR on rovara-env/<env>/o*/c* only), the `cm` entry of AGENTX_NAMES and the mirror role in the saved environment repository policy. Legacy did not move.
    // 2026-11-11, U3 work events (merged onto integ/0514 1593cf08e, whose own named and foreign pins are 113afeb8..., 5cec0a6d... and 5c52999d..., 54d2d4fb...): the named and foreign digests below are U3's, retaken from the values the test
    // reports after ONE intended change: the DeveloperTaskNotifier gains the variable AGENTX_WORK_EVENTS ("on") and one write grant, dynamodb:PutItem on ORG#org_*#WORK_EVENTS#* only. The named-templates snapshot shows exactly that variable
    // and that statement. Legacy did not move.
    // 2026-11-11 (fix/0514-integ-red, on integ 70e9fa947): the named and foreign digests were retaken after two intended changes. The company image mirror Lambda has the fixed name agentx-<env>-company-image-mirror and
    // the broker derives it (derived-names.ts), so the `cm` entry leaves AGENTX_NAMES (the broker's environment was 58 bytes short of its 400 headroom with the record on). The access stack's boundary names the image roles
    // exactly again (no img-* ARN) and the mirror role too. The named-templates snapshot shows exactly those. Legacy did not move.
    // 2026-11-11 (0.5.15, feat/0515-identity-healing-one-company): the named and foreign digests were retaken after ONE intended change: the DeveloperSignIn function's Query grant
    // loses ORG#org_*#PROJECT_CATALOG (the old race-org check, gone with IDENTITY-HEALING-CROSS-ORG). Restoring that one key gives back the previous pins. The named-templates snapshot
    // shows exactly that one line removed. Legacy did not move.
    // 2026-11-12 (0.5.15, signing key to Secrets Manager 1706c80a7 + drop CallbackSigningKey 7d8721bb6): the named and foreign digests were retaken from the values the test reports, after
    // the two reviewed infra changes: CALLBACK_SIGNING_KEY leaves the broker, EvalBatchTick and reconciler env; GetSecretValue on the two signing secrets; the named CallbackSigningKey parameter removed.
    // Checked first: at dc211668e (before both) all six tests pass on the previous pins, and infra/ differs from dc211668e only by those two lanes. Legacy did not move.
    // 2026-11-12 (0.5.15 train/0515-adapters, lane A2 adapters/a2-sqs-cloud fcf6c3bb9): the named and foreign digests were retaken from the values the test reports, after ONE intended change: the
    // DISABLED OutboxRelayBackstopSchedule (AWS::Scheduler::Schedule on the recovery schedules' role, named environments only). Checked first: with only that block switched off, all
    // pins and the named and legacy snapshots pass unchanged, and infra/ differs from integ/0515 2f072966f only by that block. Legacy did not move.
    // 2026-11-12 (0.5.15, fix/0515-allowlist-review, merged with integ/0515 0c8c0fbbc): the named and foreign digests were retaken from the values the test reports, after the internal address lane's intended infra changes
    // (its worker settings reaper alarm reading a metric-math expression of Lambda errors plus the reaper's own SessionsPrivateAddressRecycleErrors count, and the internal address resources it adds to named environments).
    // Checked first: with infra/lib's eight changed files (app, control-plane, ec2-workers, private-mcp, production-foundation, session-lifecycle, vpc-endpoints, private-addresses) put back to integ/0515's, all three tests (this one, named-templates, legacy-templates) pass on integ's own pins. Legacy did not move.
    // 2026-11-12 (0.5.15, fix/0515-notify-dm-iam, merged with integ/0515 63368e31f): the named and foreign digests were retaken from the values the test reports, after TWO intended statements on the developer
    // task notifier's role: GetItem + UpdateItem on the State table for the leading key NOTIFY_DM only (attention DMs and the Slack-member warning were refused; SlackDeliveryFailed fired on staging), and
    // GetItem + PutItem for the leading key NOTIFY_SETTINGS_PROOF#* only (the settings-proof DM's own once-marker; the project's partition is not granted). Checked first: with infra/lib/developer-task-notifier.ts
    // put back to integ/0515's and the named snapshot at integ's, all three tests (this one, named-templates, legacy-templates) pass on integ's own pins. The named snapshot shows exactly those two statements
    // added. Legacy did not move.
    // 2026-11-12 (0.5.15, fix/0515-notifier-iam-2, on integ/0515 387e4dc96): the named and foreign digests were retaken from the values the test reports, after THREE intended changes to the developer task
    // notifier's role: a GetItem-only statement for the leading keys ORG#org_* and ORG#org_*#MEMBER#* (the owner-stopped DM reads a person's membership and project grant, and was refused), and the Null
    // guard on the two statements added at 387e4dc96 (NOTIFY_DM, NOTIFY_SETTINGS_PROOF#*). Checked first: with infra/lib/developer-task-notifier.ts put back to integ/0515's, all three tests (this one,
    // named-templates, legacy-templates) pass on integ's own pins. The named snapshot shows exactly the one statement added and the two Null guards. Legacy did not move.
    // 2026-11-12 (0.5.15, fix/0515-merge-v0514, merging the v0.5.14 release 64bef8bf8 into integ/0515 878448587): the named and foreign digests were retaken from the values the test reports, after ONE intended
    // change coming in from 0.5.14 (4a5ec452f): the DeveloperSignIn function gains dynamodb:GetItem on the State table for the leading key SLACK_TEAM#* only, with the Null guard (the Slack link callback reads the
    // workspace owner; 0.5.14 is installed on staging with it, and an install of 0.5.15 without it would remove the live grant). Checked first: with infra/lib/developer-signin.ts and the named snapshot put back to
    // integ/0515's, all three tests (this one, named-templates, legacy-templates) pass on integ's own pins. The named snapshot shows exactly that one statement added. Legacy did not move.
    // 2026-11-12 (0.5.16, keyword index review round, fix/0516-record-keyword-index): infra/lib/team-record-wiring.ts gains four metric filters and alarms (TeamRecordKeywordIndex{Overdue,GateFailed,Failed,JobFailed}) and the stack parameter
    // TeamRecordKeywordIndex with its packed setting `tw`. All of it exists only with the Team record built, which none of the templates this test pins builds, so NO digest moved: checked first (the infra file put back to the branch's
    // previous version) and again with the change: this test, named-templates and legacy-templates pass on the same pins both times. The committed list of the resources the record switch adds
    // (tests/fixtures/team-record-switch-resources.json) shows exactly the eight new ids. Legacy did not move.
    const digestCases = [
      {
        label: "named",
        template: named,
        withRoute: "876d05468942b5654a2c4464dc2f57967ee137e320588c3f586c33e635610179",
        withoutRoute: "dd7a8952b232cb93c7c66a4256721ae67377a87464ac9307c3379ea468c97d33",
      },
      {
        label: "foreign",
        template: foreign,
        withRoute: "b78fff34584a4becb845ebeaee90030a83c11536e0d8467ea5fa24ec1e46a104",
        withoutRoute: "b05b7d04387318269a6272e161f176fb612635cf2eb02983aba4fa2769ee1dd6",
      },
      {
        label: "legacy",
        template: legacy,
        withRoute: "78282844236d0c6c124f4597de047d7f66cb3080b24aaa72c116393e72b15df6",
        withoutRoute: "c9cef330a90941527ceaf6b43d405e8aa2bb21a12ee3f0ae32ccb65b51ed64cf",
      },
    ] as const;
    for (const { label, template, withRoute, withoutRoute } of digestCases) {
      const creatorChecks = developerSignInConditionCheckEntries(template);
      if (label === "legacy") {
        expect(creatorChecks, "legacy has no new sign-in creator identity fence").toHaveLength(0);
      } else {
        expect(creatorChecks, `${label} has exactly one broker creator identity fence`).toHaveLength(1);
        expect(creatorChecks[0]!.statement, `${label} checks only the exact sign-in table key namespace`).toEqual({
          Action: "dynamodb:ConditionCheckItem",
          Condition: {
            "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
            Null: { "dynamodb:LeadingKeys": "false" },
          },
          Effect: "Allow",
          Resource: { "Fn::GetAtt": [creatorChecks[0]!.tableId, "Arn"] },
        });
      }
      expect(template.Resources?.ProjectSetupExecutionReadRoute, `${label} has the approved setup read route`).toMatchObject({
        Type: "AWS::ApiGatewayV2::Route",
        Properties: {
          AuthorizationType: "NONE",
          RouteKey: "GET /v1/internal/project-setups/{setupExecutionId}/execution",
        },
      });
      expect(parentRemainderDigest(template), `${label} parent remainder with the route`).toBe(withRoute);
      const priorRemainder = structuredClone(template);
      delete priorRemainder.Resources?.ProjectSetupExecutionReadRoute;
      expect(parentRemainderDigest(priorRemainder), `${label} parent remainder with only the approved route removed`).toBe(withoutRoute);
    }
  });

  it("conditions the isolated proof resources on the people switch or the proof's own, and on nothing else (no account or region lock)", () => {
    for (const template of [namedTemplate("agentxlivetest123"), namedTemplate("staging", "123456789012", "us-west-2")]) {
      const proofResources = proofEntries(template);
      const conditionId = Object.keys(template.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
      expect(conditionId).toBeDefined();
      const condition = template.Conditions?.[conditionId!];
      expect(JSON.stringify(condition)).toContain("TaskPersonProofEnabled");
      expect(JSON.stringify(condition)).toContain("TaskPeopleChangesEnabled");
      expect(JSON.stringify(condition), "no account or region in the condition").not.toMatch(/AWS::AccountId|AWS::Region|944937319445|us-east-1/);
      // The truth table, evaluated: installed when either is "true"; neither of the two invitation switches installs it (invitations are not built yet).
      const installed = (values: Record<string, string>) => evaluateCondition(condition, values);
      const off = { TaskPersonProofEnabled: "false", TaskPeopleChangesEnabled: "false", TaskPeoplePublicInvitationsEnabled: "false", TaskPeoplePrivateInvitationsEnabled: "false" };
      expect(installed(off), "both off: nothing is installed").toBe(false);
      expect(installed({ ...off, TaskPersonProofEnabled: "true" })).toBe(true);
      expect(installed({ ...off, TaskPeopleChangesEnabled: "true" })).toBe(true);
      expect(installed({ ...off, TaskPeoplePublicInvitationsEnabled: "true", TaskPeoplePrivateInvitationsEnabled: "true" }), "the invitation switches install nothing").toBe(false);
      expect(proofResources.map(([id]) => id)).toEqual(expect.arrayContaining([
        expect.stringContaining("Role"), expect.stringContaining("Function"), expect.stringContaining("Version"),
        expect.stringContaining("SecretReadPolicy"), expect.stringContaining("DispatcherPolicy"),
      ]));
      for (const [id, resource] of proofResources.filter(([, resource]) => resource.Type !== "AWS::CloudFormation::Condition")) {
        if (id.includes("Role") || id.includes("Function") || id.includes("Version") || id.includes("Policy")) {
          expect(resource.Condition).toBe(conditionId);
        }
      }
    }
  });

  it("gives a staging-shaped environment its own proof function, role and Slack secret read, and a generated role name; the live test environment keeps its fixed role name", () => {
    const staging = namedTemplate("staging", "123456789012", "us-west-2");
    const livetest = namedTemplate("agentxlivetest123");
    const roleOf = (template: TemplateJson) => Object.entries(template.Resources ?? {}).find(([id, resource]) => id.includes("TaskPersonProofRole") && resource.Type === "AWS::IAM::Role")![1];
    expect(roleOf(staging).Properties, "staging's proof role has a generated name (no fixed name, so no access stack change)").not.toHaveProperty("RoleName");
    expect(roleOf(livetest).Properties!.RoleName, "the live test role is not renamed").toBe("agentxlivetest123-task-person-proof");
    const proofFunction = Object.entries(staging.Resources ?? {}).find(([id, resource]) => id.includes("TaskPersonProofFunction") && resource.Type === "AWS::Lambda::Function")![1];
    const variables = (proofFunction.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables.AGENTX_ENV).toBe("staging");
    expect(variables.AGENTX_ACCOUNT_ID).toEqual({ Ref: "AWS::AccountId" });
    // The secret is this stack's own Slack secret, by reference, named in the one read statement.
    expect(JSON.stringify(variables.SLACK_SECRET_ARN)).toContain("SlackSecret");
    const secretPolicy = Object.entries(staging.Resources ?? {}).find(([id, resource]) => id.includes("TaskPersonProofSecretReadPolicy") && resource.Type === "AWS::IAM::Policy")![1];
    expect((secretPolicy.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement).toEqual([
      { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: [variables.SLACK_SECRET_ARN] },
    ]);
    expect(secretPolicy.Properties!.PolicyName).toBe("staging-task-person-proof-secret-read");

    // The real app's staging control plane: the dispatcher is given the same three statements as the live test one (projected sign-in reads, the proof version's invoke), on its own role alone.
    const app = appControlPlane("staging");
    const dispatcherPolicy = Object.entries(app.Resources ?? {}).find(([id, resource]) => id.includes("TaskPersonProofDispatcherPolicy") && resource.Type === "AWS::IAM::Policy")![1];
    const statements = (dispatcherPolicy.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(3);
    expect(JSON.stringify(statements.find((statement) => JSON.stringify(statement.Action).includes("dynamodb:GetItem") && statement.Effect === "Allow")?.Condition))
      .toContain(JSON.stringify([...TASK_PERSON_DEVELOPER_RECORD_PROJECTION]));
    expect(dispatcherPolicy.Properties!.Roles).toHaveLength(1);
    expect(dispatcherPolicy.Properties!.PolicyName).toBe("staging-task-person-proof-dispatcher");
    const invoke = statements.find((statement) => JSON.stringify(statement.Action).includes("lambda:InvokeFunction"));
    expect(JSON.stringify(invoke?.Resource)).toContain("TaskPersonProofFunctionCurrentVersion");
  });

  it("keeps the proof function and role free of unrelated runtime permissions", () => {
    const approved = namedTemplate("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const [functionId, proofFunction] = Object.entries(resources).find(([id, resource]) =>
      id.includes("TaskPersonProofFunction") && resource.Type === "AWS::Lambda::Function",
    )!;
    const properties = proofFunction.Properties!;
    expect(properties).toMatchObject({ MemorySize: 512, Timeout: 7 });
    expect(properties).not.toHaveProperty("TracingConfig");
    expect(properties).not.toHaveProperty("VpcConfig");
    const variables = (properties.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(variables).toMatchObject({ AGENTX_ENV: "agentxlivetest123" });
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ACCOUNT_ID", "AGENTX_ENV", "SLACK_SECRET_ARN", "SLACK_TEAM_ID"]);
    const roleId = ((properties.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(roleId).toContain("TaskPersonProofRole");
    const role = resources[roleId]!.Properties!;
    expect(role).not.toHaveProperty("ManagedPolicyArns");
    expect(JSON.stringify(role.AssumeRolePolicyDocument)).toContain("lambda.amazonaws.com");
    const rolePolicies = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::IAM::Policy"
      && JSON.stringify(resource.Properties?.Roles).includes(roleId));
    expect(rolePolicies).toHaveLength(1);
    const statements = (rolePolicies[0]![1].Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatchObject({ Effect: "Allow", Action: ["secretsmanager:GetSecretValue"] });
    expect(JSON.stringify(statements[0]?.Resource)).toContain("SlackSecret");
    expect(JSON.stringify(proofFunction)).not.toMatch(/xray:|logs:|kms:|dynamodb:/);
    expect(functionId).toContain("TaskPersonProofFunction");
  });

  it("limits the dispatcher addition to projected Developer GetItem and the published proof version", () => {
    const approved = appControlPlane("agentxlivetest123");
    const resources = approved.Resources ?? {};
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const policy = Object.entries(resources).find(([id, resource]) => id.includes("TaskPersonProofDispatcherPolicy") && resource.Type === "AWS::IAM::Policy")?.[1];
    expect(policy).toBeDefined();
    const statements = (policy!.Properties!.PolicyDocument as { Statement: Array<Record<string, unknown>> }).Statement;
    expect(statements).toHaveLength(3);
    const getItem = statements.find((statement) => JSON.stringify(statement.Action).includes("dynamodb:GetItem"));
    const denyUnprojectedGetItem = statements.find((statement) => statement.Sid === "DenyGetItemUnlessSpecificAttributes");
    const invoke = statements.find((statement) => JSON.stringify(statement.Action).includes("lambda:InvokeFunction"));
    const dispatcherEntries = Object.entries(resources).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
    expect(dispatcherEntries).toHaveLength(1);
    const dispatcher = dispatcherEntries[0];
    const dispatcherRole = ((dispatcher![1].Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    expect(policy!.Properties!.Roles).toEqual([{ Ref: dispatcherRole }]);
    const tableId = Object.keys(resources).find((id) => id.includes("DeveloperSignInTable"));
    expect(tableId).toBeDefined();
    expect(getItem).toEqual({
      Effect: "Allow",
      Action: ["dynamodb:GetItem"],
      Resource: [{ "Fn::GetAtt": [tableId, "Arn"] }],
      Condition: {
        "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["DEVELOPER#*"] },
        "ForAllValues:StringEquals": { "dynamodb:Attributes": [...TASK_PERSON_DEVELOPER_RECORD_PROJECTION] },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    });
    // The attributes IAM allows are the ones the person runtime asks for, name for name: a name asked for and not allowed (`mergedInto` was) refuses every read of a sign-in row.
    expect([...TASK_PERSON_DEVELOPER_RECORD_ATTRIBUTES].sort()).toEqual([...TASK_PERSON_DEVELOPER_RECORD_PROJECTION].sort());
    expect(TASK_PERSON_DEVELOPER_RECORD_PROJECTION).toContain("mergedInto");
    const expectedProjectionDeny = {
      Sid: "DenyGetItemUnlessSpecificAttributes",
      Effect: "Deny",
      Action: "dynamodb:GetItem",
      Resource: { "Fn::GetAtt": [tableId, "Arn"] },
      Condition: { StringNotEqualsIfExists: { "dynamodb:Select": "SPECIFIC_ATTRIBUTES" } },
    };
    const assertExactProjectionDeny = (statement: Record<string, unknown>) => expect({
      ...statement,
      Action: normalizeSingleton(statement.Action),
      Resource: normalizeSingleton(statement.Resource),
    }).toEqual(expectedProjectionDeny);
    assertExactProjectionDeny(denyUnprojectedGetItem!);
    const extraNullCounterfactual = structuredClone(denyUnprojectedGetItem!);
    extraNullCounterfactual.Condition = {
      ...(extraNullCounterfactual.Condition as Record<string, unknown>),
      Null: { "dynamodb:Select": "false" },
    };
    expect(() => assertExactProjectionDeny(extraNullCounterfactual)).toThrow();
    const versionId = Object.keys(resources).find((id) => JSON.stringify(invoke?.Resource).includes(id));
    expect(invoke).toEqual({ Effect: "Allow", Action: ["lambda:InvokeFunction"], Resource: [{ Ref: versionId }] });
    expect(versionId).toContain("TaskPersonProofFunctionCurrentVersion");
    expect(resources[versionId!]?.Type).toBe("AWS::Lambda::Version");
    expect(JSON.stringify(invoke?.Resource)).not.toContain("$LATEST");
    const variables = dispatcher![1].Properties!.Environment as { Variables: Record<string, unknown> };
    expect(Object.keys(variables.Variables).filter((key) => ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"].includes(key)).sort()).toEqual([
      "TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME",
    ].sort());
    expect(JSON.stringify(variables.Variables.TASK_PERSON_PROOF_FUNCTION_ARN)).toContain("TaskPersonProofFunctionCurrentVersion");
    for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
      expect(JSON.stringify(variables.Variables[key])).toContain(conditionId);
    }

    const functions = Object.entries(resources).filter(([, resource]) => resource.Type === "AWS::Lambda::Function");
    const roleFor = (resource: { Properties?: Record<string, unknown> }): string =>
      ((resource.Properties!.Role as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"])[0];
    const purpose = (prefix: string) => {
      const matches = functions.filter(([id]) => id.startsWith(prefix));
      expect(matches, `expected exactly one ${prefix} Lambda`).toHaveLength(1);
      return matches[0]!;
    };
    const [brokerId, broker] = purpose("Broker");
    const [notifierId, notifier] = purpose("DeveloperTaskNotifier");
    const [signInId, signIn] = purpose("DeveloperSignIn");
    for (const [id, resource] of [[brokerId, broker], [notifierId, notifier], [signInId, signIn]] as const) {
      const envVars = (resource.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
      expect(envVars, `${id} must not receive proof-only runtime configuration`).not.toHaveProperty("TASK_PERSON_PROOF_FUNCTION_ARN");
    }
    const brokerVars = (broker.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(brokerSettingsIn(brokerVars).slackTeamId).toEqual({ Ref: "SlackTeamId" });
    expect(brokerVars.SLACK_TEAM_ID).toBeUndefined();
    expect(brokerVars.DEVELOPER_SIGNIN_TABLE_NAME).toBeUndefined();
    expect(brokerNamesIn(brokerVars).signInTable).toEqual({ Ref: tableId });
    const notifierVars = (notifier.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(notifierVars.SLACK_TEAM_ID).toBeUndefined();
    expect(notifierVars.DEVELOPER_SIGNIN_TABLE_NAME).toBeUndefined();
    const signInVars = (signIn.Properties!.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(signInVars.SLACK_TEAM_ID).toEqual({ Ref: "SlackTeamId" });
    expect(signInVars.DEVELOPER_SIGNIN_TABLE_NAME).toEqual({ Ref: tableId });

    const proofPolicyRoles = policy!.Properties!.Roles as Array<{ Ref?: string }>;
    expect(proofPolicyRoles).toEqual([{ Ref: dispatcherRole }]);
    for (const [, otherFunction] of [[brokerId, broker], [notifierId, notifier], [signInId, signIn]] as const) {
      expect(proofPolicyRoles).not.toContainEqual({ Ref: roleFor(otherFunction) });
    }
  });
});
