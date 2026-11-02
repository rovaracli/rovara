import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
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
  // Setup agent (sh-setup-wire): its own switch, a parameter and a packed setting, no part of the proof-only addition.
  delete remainder.Parameters?.SetupAgentEnabled;
  const conditions = remainder.Conditions ?? {};
  for (const id of Object.keys(conditions)) if (id.includes("InstallTaskPersonProof")) delete conditions[id];
  const resources = remainder.Resources ?? {};
  for (const id of Object.keys(resources)) if (id.startsWith("TaskPersonProof")) delete resources[id];
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
    if (brokerVariables.Variables.AGENTX_SETTINGS !== undefined) takeBrokerSettings(brokerVariables.Variables, ["workflowDependencies", "rovaraCodeV2", "planSelfCheck", "autofix", "liveSteer", "liveRedirect", "liveAsk", "liveFix", "proofEvidence", "decisionCards", "testEnvironment", "learnedLessons", "setupAgent", "secondReview", "setupRecipes", "nightlyHealth", "learningSuggestionsDefault"]);
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
  it("declares a distinct default-OFF gate only for the approved named environment", () => {
    const approved = namedTemplate("agentxlivetest123");
    const foreign = namedTemplate("staging", "123456789012");
    const wrongAccount = namedTemplate("agentxlivetest123", "123456789012");
    const legacy = Template.fromStack(new ControlPlaneStack(new App(), "Legacy")).toJSON() as TemplateJson;

    expect(approved.Parameters?.TaskPersonProofEnabled).toMatchObject({
      Type: "String",
      Default: "false",
      AllowedValues: ["true", "false"],
    });
    expect(proofEntries(approved).length).toBeGreaterThan(0);
    expect(approved.Parameters?.TaskPeopleChangesEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePublicInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(approved.Parameters?.TaskPeoplePrivateInvitationsEnabled).toMatchObject({ Default: "false" });
    expect(foreign.Parameters?.TaskPersonProofEnabled).toBeUndefined();
    expect(proofEntries(foreign)).toHaveLength(0);
    expect(wrongAccount.Parameters?.TaskPersonProofEnabled).toMatchObject({ Default: "false" });
    expect(proofEntries(wrongAccount).length).toBeGreaterThan(0);
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

    for (const [label, template] of [["staging", foreign], ["legacy", legacy]] as const) {
      expect(template.Parameters?.TaskPersonProofEnabled, `${label} has no proof-only parameter`).toBeUndefined();
      expect(proofEntries(template), `${label} has no proof-only resources`).toHaveLength(0);
      const dispatchers = Object.entries(template.Resources ?? {}).filter(([id, resource]) => id.startsWith("Dispatcher") && resource.Type === "AWS::Lambda::Function");
      expect(dispatchers, `${label} has its ordinary Dispatcher`).toHaveLength(1);
      const variables = dispatchers[0]![1].Properties!.Environment as { Variables: Record<string, unknown> };
      for (const key of ["TASK_PERSON_PROOF_FUNCTION_ARN", "SLACK_TEAM_ID", "DEVELOPER_SIGNIN_TABLE_NAME"]) {
        expect(variables.Variables, `${label} has no proof-only ${key}`).not.toHaveProperty(key);
      }
    }

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
    const digestCases = [
      {
        label: "named",
        template: named,
        withRoute: "65b51951d0c039c5f1502e2bce773ee41c79cac7ec44db4e35d9eb61726695e0",
        withoutRoute: "44a1860493231beae8acc4ec0e23719e08bb608c73519668ee13ddb3b62e10a1",
      },
      {
        label: "foreign",
        template: foreign,
        withRoute: "1d40cfff0db6c4fdd60f73588e3a6f88b7334586fb0c34db300f3b5a4362787f",
        withoutRoute: "2dd13ddd9349f68bcfaee13fcbf64424c2b59708bf61108f7b751d9a5ac046d9",
      },
      {
        label: "legacy",
        template: legacy,
        withRoute: "ca953d736cf5102d9dfb0779215fed9175e7763a0fbe21379706561eb2a75f42",
        withoutRoute: "25d3a6bd95423e5758293ece7225df8d8f204bafa6c08d5e29e1538a0322ff0a",
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

  it("conditions the isolated proof resources on the switch, exact account and region", () => {
    const approved = namedTemplate("agentxlivetest123");
    const proofResources = proofEntries(approved);
    const conditionId = Object.keys(approved.Conditions ?? {}).find((id) => id.includes("InstallTaskPersonProof"));
    expect(conditionId).toBeDefined();
    const condition = approved.Conditions?.[conditionId!];
    expect(JSON.stringify(condition)).toContain("TaskPersonProofEnabled");
    expect(JSON.stringify(condition)).toContain("944937319445");
    expect(JSON.stringify(condition)).toContain("us-east-1");
    expect(proofResources.map(([id]) => id)).toEqual(expect.arrayContaining([
      expect.stringContaining("Role"), expect.stringContaining("Function"), expect.stringContaining("Version"),
      expect.stringContaining("SecretReadPolicy"), expect.stringContaining("DispatcherPolicy"),
    ]));
    for (const [id, resource] of proofResources.filter(([, resource]) => resource.Type !== "AWS::CloudFormation::Condition")) {
      if (id.includes("Role") || id.includes("Function") || id.includes("Version") || id.includes("Policy")) {
        expect(resource.Condition).toBe(conditionId);
      }
    }
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
    expect(Object.keys(variables).sort()).toEqual(["AGENTX_ENV", "SLACK_SECRET_ARN", "SLACK_TEAM_ID"]);
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
        "ForAllValues:StringEquals": { "dynamodb:Attributes": ["pk", "sk", "developerId", "provider", "issuer", "subject", "slackUserId", "revoked", "displayName"] },
        Null: { "dynamodb:LeadingKeys": "false", "dynamodb:Attributes": "false" },
      },
    });
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
