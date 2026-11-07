// Spec 025 A13 and A6: the broker's health grants are exact, the index TTL is on, and both exist
// only in named environments.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { App, Stack } from "aws-cdk-lib";
import { Template } from "aws-cdk-lib/assertions";
import { Alarm, AlarmRule, AlarmState, CompositeAlarm, Metric } from "aws-cdk-lib/aws-cloudwatch";
import { HEALTH_ALARM_SUFFIXES } from "@agentx/contracts";
import { buildAgentXApp } from "../../infra/lib/app.js";
import { describe, expect, it } from "vitest";
import { ControlPlaneStack } from "../../infra/lib/control-plane.js";
import { environmentNaming } from "../../infra/lib/naming.js";
import { hydrateBrokerEnvironment, type MutableEnvironment } from "../../packages/broker/src/aws/broker-environment.js";
import { brokerNamesIn } from "../support/broker-names-template.js";
import { skipLambdaBundling } from "../support/skip-bundling.js";
import { brokerSourceFiles, readBrokerSource } from "../support/broker-source.js";

skipLambdaBundling();

type Statement = { Action: string | string[]; Resource: unknown };
type Policy = { Properties: { PolicyDocument: { Statement: Statement[] }; Roles: Array<{ Ref?: string }> } };
type LambdaFunction = { Properties: { Environment?: { Variables?: Record<string, unknown> } } };

function brokerStatements(template: Template): Statement[] {
  return ([...Object.values(template.findResources("AWS::IAM::Policy")), ...Object.values(template.findResources("AWS::IAM::ManagedPolicy"))] as Policy[])
    .filter((policy) => policy.Properties.Roles.some((role) => role.Ref?.startsWith("BrokerServiceRole")))
    .flatMap((policy) => policy.Properties.PolicyDocument.Statement);
}
function brokerEnvironment(template: Template): Record<string, unknown> {
  const functions = Object.entries(template.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
  const broker = functions.find(([id]) => /^Broker[0-9A-F]{8}$/.test(id));
  return broker?.[1].Properties.Environment?.Variables ?? {};
}

describe("the health route's grants (A13)", () => {
  const named = Template.fromStack(new ControlPlaneStack(new App(), "HealthControlPlane", { naming: environmentNaming("live25d") }));
  const legacy = Template.fromStack(new ControlPlaneStack(new App(), "HealthLegacyControlPlane"));

  it("lets the broker describe the environment's alarms, by their name prefix only", () => {
    const describe = brokerStatements(named).filter((statement) => statement.Action === "cloudwatch:DescribeAlarms");
    expect(describe).toHaveLength(1);
    expect(JSON.stringify(describe[0]?.Resource)).toContain(":alarm:agentx-live25d-*");
    // The prefix is not a variable of the broker's (its variables are held to Lambda's 4 KB): the broker derives it from AGENTX_ENV, and
    // what it derives is the prefix every alarm of the environment is named with.
    expect(brokerEnvironment(named).AGENTX_ALARM_PREFIX).toBeUndefined();
    expect(brokerEnvironment(named).AGENTX_ENV).toBe("live25d");
    const derived: MutableEnvironment = { AGENTX_ENV: "live25d", AGENTX_NAMES: "{}", AWS_REGION: "us-east-1", AGENTX_ACCOUNT_ID: "123456789012" };
    hydrateBrokerEnvironment(derived);
    expect(derived.AGENTX_ALARM_PREFIX).toBe(environmentNaming("live25d").alarmName(""));
    expect(derived.AGENTX_ALARM_PREFIX).toBe("agentx-live25d-");
  });

  // Issue 206: a DescribeAlarms call by name prefix is authorized against *, so the probe asks for
  // the environment's alarms by exact name (HEALTH_ALARM_SUFFIXES), authorized against each alarm's ARN.
  it("names every alarm a named app creates in the probe's list, and lists no alarm the app never creates (issue 206)", () => {
    const alarmNamesOf = (context: Record<string, unknown>) => buildAgentXApp({ agentxEnv: "live25d", ...context }).node.children.filter((child): child is Stack => Stack.isStack(child))
      .flatMap((stack) => Object.values(Template.fromStack(stack).findResources("AWS::CloudWatch::Alarm") as Record<string, { Properties: { AlarmName?: unknown } }>))
      .map((alarm) => alarm.Properties.AlarmName);
    const stacks = buildAgentXApp({ agentxEnv: "live25d" }).node.children.filter((child): child is Stack => Stack.isStack(child));
    // The automatic renewal's alarms exist only where its CDK context is on (AR-2).
    expect([...alarmNamesOf({})].sort()).toStrictEqual(HEALTH_ALARM_SUFFIXES.filter((suffix) => !suffix.startsWith("RuntimeRequalify")).map((suffix) => `agentx-live25d-${suffix}`).sort());
    expect([...alarmNamesOf({ "agentx:autoRequalify": "enabled" })].sort()).toStrictEqual(HEALTH_ALARM_SUFFIXES.map((suffix) => `agentx-live25d-${suffix}`).sort());
    expect(stacks.flatMap((stack) => Object.keys(Template.fromStack(stack).findResources("AWS::CloudWatch::CompositeAlarm")))).toEqual([]);
  }, 120_000);

  it("keeps the grant the unchanged prefix ARN, which covers every listed name (issue 206)", () => {
    expect(brokerStatements(named).filter((statement) => statement.Action === "cloudwatch:DescribeAlarms")).toStrictEqual([{
      Action: "cloudwatch:DescribeAlarms",
      Effect: "Allow",
      Resource: { "Fn::Join": ["", ["arn:", { Ref: "AWS::Partition" }, ":cloudwatch:", { Ref: "AWS::Region" }, ":", { Ref: "AWS::AccountId" }, ":alarm:agentx-live25d-*"]] },
    }]);
    for (const suffix of HEALTH_ALARM_SUFFIXES) expect(suffix).toMatch(/^[A-Za-z0-9]+$/);
  });

  it("refuses to synthesize an alarm the probe would not read: unlisted, outside the prefix, or composite (issue 206)", () => {
    const metric = new Metric({ namespace: "AgentX/live25d", metricName: "Stray" });
    for (const alarmName of ["other-SlackDeadLetters", "agentx-live25d-Unlisted", "agentx-live25d-eu-SlackDeadLetters"]) {
      const stack = new ControlPlaneStack(new App(), "StrayAlarmControlPlane", { naming: environmentNaming("live25d") });
      new Alarm(stack, "Stray", { alarmName, metric, threshold: 1, evaluationPeriods: 1 });
      expect(() => Template.fromStack(stack)).toThrow(`the health probe does not read alarm StrayAlarmControlPlane/Stray/Resource (${alarmName})`);
    }
    const stack = new ControlPlaneStack(new App(), "CompositeControlPlane", { naming: environmentNaming("live25d") });
    const member = new Alarm(stack, "Member", { alarmName: "agentx-live25d-TestAlarm", metric, threshold: 1, evaluationPeriods: 1 });
    new CompositeAlarm(stack, "Composite", { compositeAlarmName: "agentx-live25d-Composite", alarmRule: AlarmRule.fromAlarm(member, AlarmState.ALARM) });
    expect(() => Template.fromStack(stack)).toThrow("the health probe cannot read composite alarm CompositeControlPlane/Composite/Resource");
    }, 120_000);

  it("lets the broker read the attributes of exactly the four dead-letter queues", () => {
    const queues = brokerStatements(named).filter((statement) => statement.Action === "sqs:GetQueueAttributes");
    expect(queues).toHaveLength(1);
    expect(queues[0]?.Resource).toHaveLength(4);
    // Exactly the four queues' own ARNs, one each: no wildcard, no other queue.
    const queueIds = [/^DispatchDeadLetterQueue[0-9A-F]{8}$/, /^SlackRequestDeadLetterQueue[0-9A-F]{8}$/, /^DeveloperTaskNotifierNoticeDeadLetterQueue[0-9A-F]{8}$/, /^DeveloperTaskNotifierStreamFailureQueue[0-9A-F]{8}$/];
    const resources = queues[0]?.Resource as Array<{ "Fn::GetAtt"?: [string, string] }>;
    for (const resource of resources) {
      expect(resource).toEqual({ "Fn::GetAtt": [expect.any(String), "Arn"] });
      expect(Object.keys(named.findResources("AWS::SQS::Queue"))).toContain(resource["Fn::GetAtt"]?.[0]);
    }
    for (const id of queueIds) expect(resources.filter((resource) => id.test(resource["Fn::GetAtt"]?.[0] ?? ""))).toHaveLength(1);
    // The broker is given the four queues' names (in its one variable of names), and lists them for the route under the labels it always has.
    const names = brokerNamesIn(brokerEnvironment(named));
    const queueNameOf = (key: keyof typeof names) => (names[key] as { "Fn::GetAtt": [string, string] })["Fn::GetAtt"];
    const labelled = [["dispatchDeadLetters", queueIds[0]!], ["slackRequestDeadLetters", queueIds[1]!], ["developerNoticeDeadLetters", queueIds[2]!], ["developerNoticeStreamFailures", queueIds[3]!]] as const;
    for (const [key, id] of labelled) {
      const [logicalId, attribute] = queueNameOf(key);
      expect(attribute, key).toBe("QueueName");
      expect(id.test(logicalId), `${key} is ${logicalId}`).toBe(true);
    }
    expect(brokerEnvironment(named).HEALTH_DEAD_LETTER_QUEUES).toBeUndefined();
    const derived: MutableEnvironment = { AGENTX_ENV: "live25d", AGENTX_NAMES: JSON.stringify({ dq: "a", sr: "b", dn: "c", ds: "d" }), AWS_REGION: "us-east-1", AGENTX_ACCOUNT_ID: "123456789012" };
    hydrateBrokerEnvironment(derived);
    expect(Object.keys(JSON.parse(derived.HEALTH_DEAD_LETTER_QUEUES!) as object)).toEqual(["dispatch", "slack-requests", "developer-notices", "developer-notice-stream"]);
  });

  it("expires index items by TTL on indexExpiresAt in a named environment, and tells the reconciler so (A6, Q5)", () => {
    const tables = Object.values(named.findResources("AWS::DynamoDB::Table") as Record<string, { Properties: { StreamSpecification?: unknown; TimeToLiveSpecification?: unknown } }>);
    const state = tables.filter((table) => table.Properties.StreamSpecification !== undefined);
    expect(state).toHaveLength(1);
    expect(state[0]?.Properties.TimeToLiveSpecification).toEqual({ AttributeName: "indexExpiresAt", Enabled: true });
    const functions = Object.entries(named.findResources("AWS::Lambda::Function") as Record<string, LambdaFunction>);
    const reconciler = functions.find(([id]) => /Reconciler[0-9A-F]{8}$/.test(id));
    expect(reconciler?.[1].Properties.Environment?.Variables).toMatchObject({ INDEX_EXPIRY: "ttl" });
  });

  // 25c note 2 (owner answer, 2026-09-30): NOTICE (the notifier) and CHANNEL_OPERATION (broker.ts) items expire on it too.
  // Spec 025 phase 25e: pending admin changes and their audit records expire on it as well.
  it("names indexExpiresAt only where index, notice, channel-operation, admin-change and audit-pending items are written or read, so the TTL deletes nothing else", () => {
    const allowed = new Set([
      "packages/contracts/src/admin.ts", "packages/broker/src/aws/activity-index.ts", "packages/broker/src/aws/admin-reads.ts", "infra/lib/control-plane.ts",
      "packages/broker/src/aws/developer-task-notifier.ts", ...brokerSourceFiles(),
      // The workflow dispatch row's one definition, shared by the broker and the developer task routes.
      "packages/broker/src/aws/broker-shared.ts",
      "packages/contracts/src/admin-changes.ts", "packages/broker/src/aws/admin-changes.ts",
      // The plan evidence job row (spec 061) expires on it too.
      "packages/broker/src/developer/plan-evidence-jobs.ts",
      // Fixed-window rate rows (takeRateAt): each window's row expires on it, 30 days after the window opens.
      "packages/broker/src/developer/page-comments.ts",
      // Retired and quarantined recovery rows only; active retries remove the due/lease fields without TTL.
      "packages/broker/src/aws/workflow-merge-recovery.ts",
      // The audit outbox's AUDIT_PENDING# items (Audit Ledger, Task 6) expire on it too; the drain only reads them.
      "packages/broker/src/audit/outbox.ts",
      // The GitHub connect state row (Plan 2, Task 12): single-use, minutes long, and deleted by the TTL a retention period after it lapses.
      // Plan 2, Tasks 13 to 15: the delivery ids and the notice outbox rows expire on it too.
      "packages/broker/src/org/github-connection.ts", "packages/broker/src/org/github-install-requests.ts",
      // Plan 2, Task 21: a project's member-change request records (replay keys) expire on it after a day.
      "packages/broker/src/org/project-members.ts",
      // Reviewed company-role replay receipts become TTL-eligible after 30 days in named environments; legacy tables retain them.
      "packages/broker/src/org/role-changes.ts",
      // Plan 2, Task 22: a project's setup-check request records (replay keys) expire on it after a day.
      "packages/broker/src/org/project-setup-check.ts",
      // Final review M2: the one request-id pattern's record (archive and restore, staff egress decisions) expires on it after a day.
      "packages/broker/src/org/request-records.ts",
      // The agent request items (Plan 3, Task 7): one per marked write, kept 7 days so a retry is answered, then deleted by the TTL.
      // table-writes.ts writes them for the agent store and the skill store; store.ts reads them back.
      "packages/broker/src/agents/store.ts", "packages/broker/src/agents/table-writes.ts",
      // A run's request item and an agent's task index item (Plan 3, Task 15): kept 90 days, then deleted by the TTL.
      "packages/broker/src/agents/runs.ts",
      // The org connection routes' request items (Plan 3, Task 12b): read back on a repeat, kept 7 days, then deleted by the TTL.
      "packages/broker/src/connections/routes.ts",
      // Plan 3, Tasks 14b and 20b: the comment-trigger opt-outs, the run cache and the run's own items expire on it too.
      "packages/broker/src/agents/comment-trigger-optouts.ts", "packages/broker/src/agents/write-class.ts", "packages/broker/src/agents/run-cache.ts",
      // Plan 3, Task 21: the approvals' approver items and step counters expire on it too (their open-index items are deleted when they are done).
      "packages/broker/src/agents/approvals-store.ts", "packages/broker/src/agents/approvals-movers.ts",
      // A company AI source change's request item (Plan 3, Task 24b): kept 7 days so a retry is answered, then deleted by the TTL.
      "packages/broker/src/model-sources/store.ts",
      // A run's cost item (Plan 3, Task 34): kept a year for the max-per-run suggestion, then deleted by the TTL.
      "packages/broker/src/spend/estimate.ts",
      // Plan 5, Tasks 2 and 4: a session's events, and the shares, share index items and request items written for an ended session, expire with it.
      "packages/broker/src/agent-sessions/store.ts", "packages/broker/src/agent-sessions/shares.ts",
      // Plan 5, Tasks 6 and 7a: the event log reads it back (and leaves it off an event it returns); a session's end sets it on the session and its live tile
      // (summary.ts); the drain sets it on an ended session's items and the sweep reads a presence item's (sweep.ts).
      "packages/broker/src/agent-sessions/events.ts", "packages/broker/src/agent-sessions/summary.ts", "packages/broker/src/agent-sessions/sweep.ts",
      // Plan 5, Task 9: a follower item expires with its ended session, and a presence item (who is looking now) expires in minutes (followers.ts writes both).
      "packages/broker/src/agent-sessions/followers.ts",
      // Plan 5, Task 14 review: the Live wall leaves out a presence row whose own expiry has passed (live.ts reads it; the table deletes late).
      "packages/broker/src/agent-sessions/live.ts",
      // Plan 5, Task 10: a session's comments, its per-hour comment rate item, its message count and its request items (replay keys) expire on it (messages.ts
      // writes them, drops a comment the table hasn't deleted yet, and replays a request only while its item lives).
      "packages/broker/src/agent-sessions/messages.ts",
      // Plan 5, Task 11a: the queued-steer count of a session expires with the session; the steer messages share messages.ts's items (steer.ts writes the count).
      "packages/broker/src/agent-sessions/steer.ts",
      // Plan 5, Tasks 12b and 13: the take-over's follow-up mark and the request, stop and retry marks of a session expire with it (take-over.ts, stop.ts and retry.ts write them).
      "packages/broker/src/agent-sessions/take-over.ts", "packages/broker/src/agent-sessions/stop.ts", "packages/broker/src/agent-sessions/retry.ts",
      // Plan 5, Task 15: a dismissed Home card is kept 30 days, then deleted by the TTL (home.ts writes it and ignores one past its time).
      "packages/broker/src/agent-sessions/home.ts",
      // Live interaction R2-R4: a redirect's record, its open marker and the redirect message expire on it (redirect-state.ts, redirect.ts), like a session's own items.
      "packages/broker/src/agent-sessions/redirect-state.ts", "packages/broker/src/agent-sessions/redirect.ts",
      // Live interaction A3/A5: an Ask's records, its one-at-a-time lock and rate rows (ask.ts), the daily Ask count (ask-audit.ts) and the erased-person alias items,
      // kept at most 30 days (ask-erased-aliases.ts), expire on it.
      "packages/broker/src/agent-sessions/ask.ts", "packages/broker/src/agent-sessions/ask-audit.ts", "packages/broker/src/agent-sessions/ask-erased-aliases.ts",
      // Live interaction L1: a Linear comment's seen-marker (a replay key) expires on it.
      "packages/broker/src/rovara-code/linear-comments.ts",
      // CodeHost P6: a neutral code-host event's reservation row (dedupe) expires on it after 30 days.
      "packages/broker/src/plugins/events/reservations.ts",
      // Live interaction F2/F3: a diagnosis's record, its one-open-place item and its rate rows expire on it (store.ts writes and reads them; deep.ts writes the deep record).
      "packages/broker/src/diagnosis/store.ts", "packages/broker/src/diagnosis/deep.ts",
      // Plan 5, Task 21: a closed org's session data, and a removed member's revoked devices, are given a short expiry (lifecycle.ts shortens it, never lengthens).
      "packages/broker/src/agent-sessions/lifecycle.ts",
      // Plan 5, Task 17: a removed device keeps its record, and its row in the member's list, for a year (`revokedAt`), then the TTL deletes both.
      "packages/broker/src/devices/store.ts",
      // UX5b: a script token's record and its row in the company's list expire a month after the token ends (or is revoked).
      "packages/broker/src/script-tokens/store.ts",
      // Plan 5, Task 18: a local session's state, its turns, its device entry and a device's commands (and the counter beside them) expire on it (local-sessions.ts writes them; a command past its time is left out of a poll).
      "packages/broker/src/devices/local-sessions.ts",
      // Plan 5, Task 19: a move to a Mac starts the Mac's state and entry for the session with the same expiry (handoff.ts writes them), and the move's request item expires like a stop's.
      "packages/broker/src/agent-sessions/handoff.ts",
      // Plan 5, Task 8: each person's change notices (the catch-up feed) expire a week after they are written.
      "packages/broker/src/realtime/changes.ts",
      // A plan's "asked again" cooldown item (Plan 3, Task 35b): kept a day, then deleted by the TTL.
      "packages/broker/src/spend/requests.ts",
      // Plan 4 (Tasks 18 to 20): the trigger store's activity, notices and counters, the hook ingress's de-duplication and rate items, and dispatch's rate counters and subject notes
      // are short-lived records that the TTL deletes; none is read as anything else.
      "packages/broker/src/triggers/store.ts", "packages/broker/src/triggers/ingress.ts", "packages/broker/src/triggers/dispatch.ts",
      // The AI navigation day-budget rows (M1.4 Task 4.2) expire on it: one tiny row per project per UTC day.
      "packages/broker/src/e2e/model-route-registry.ts",
      // The model check rows (M1.4 Task 4.10C: a requested check and the pointer to the latest one) expire on it after one day.
      "packages/broker/src/e2e/model-checks.ts",
      // The worker's callback for those day-budget rows (M1.4 Task 4.3a) writes the day's row and one reservation row per model call; both expire on it at the end of their UTC day.
      "packages/broker/src/e2e/model-budget-endpoint.ts",
      // The baseline round's record (M1.3 Task 3.7b, owner decision D4): it expires 30 days after it was last written.
      "packages/broker/src/aws/workflow-e2e-baseline.ts",
      "packages/broker/src/aws/workflow-e2e-grounding.ts",
      // The audit replay's record (M1.4 Task 4.6b) has the baseline record's expiry: 30 days after it was last written.
      "packages/broker/src/aws/workflow-e2e-replay.ts",
      // Rovara Code (Plan 6): the milestone records a task writes for the people following it (Task 5), the duration history of a project's runs (Task 7), the record of an applied
      // setup draft (Task 10) and the index from a pull request's head to its task (Task 14) are short-lived records of their own modules, kept for a fixed time and then deleted by the TTL.
      "packages/broker/src/rovara-code/milestones.ts", "packages/broker/src/rovara-code/duration.ts", "packages/broker/src/rovara-code/setup-draft.ts", "packages/broker/src/rovara-code/head-index.ts",
      // Rovara Code (Plan 6 Task 15): what CI said, kept for the coding run of the fix round that started with it (30 days, then the TTL deletes it); only ci-fix.ts writes and reads it.
      "packages/broker/src/rovara-code/ci-fix.ts",
      // Rovara Code (Plan 6 Task 16): the replies a landed push of an automatic comment fix left to send (30 days, then the TTL deletes them); only feedback-autonomy.ts writes and sends them.
      "packages/broker/src/rovara-code/feedback-autonomy.ts",
      // Rovara Code (Plan 6 Task 18): the record that a review reminder was sent (and when the next may be), kept for the waiting window (REVIEW_WAIT_RETENTION_DAYS), then the TTL deletes it; only nudges.ts writes and reads it.
      "packages/broker/src/rovara-code/nudges.ts",
      // Rovara Code (Plan 6 Task 19): the change notice a confirmed code-settings change leaves for the people it concerns is an ordinary notice (it expires like the others); only code-settings.ts writes it.
      "packages/broker/src/rovara-code/code-settings.ts",
      // Rovara Code (Plan 6 Task 23): a Slack share's undo record and the owner's change notice of a widened share last seven days, then the TTL deletes them; only sharing.ts writes them.
      "packages/broker/src/rovara-code/sharing.ts",
      // The marker a project setup run leaves for the test machine renewal's drain (AUTOREQUALIFY AR-3) ends at the run's deadline and expires on it a day later.
      "packages/broker/src/e2e/requalify-hold.ts",
      // C53: replay only reads the existing AGENT_REQUEST receipt expiry in a ConditionCheck; it creates no new TTL-bearing entity.
      "packages/broker/src/model-selection/selection-write.ts",
      // C53 company replay also only reads existing AGENT_REQUEST expiry; it creates no new TTL-bearing entity.
      "packages/broker/src/model-selection/company-write.ts",
      // B33: proposal and atomic narrowing receipts expire after the explicit authority window plus cleanup retention.
      "packages/broker/src/org/project-allowed-domains.ts",
      "packages/broker/src/org/legacy-domain-narrowing.ts",
      // B34: existing request retention reads and bounded Slack pending approval cleanup retention.
      "packages/broker/src/org/project-slack-browser.ts",
      "packages/broker/src/org/project-slack-proposals.ts",
      // 2026-11-02, sh-health-wire (SH28): the project's health record (`TEST_ENV_HEALTH`, one item per project, rewritten by the nightly run) expires after 60 days (HEALTH_TTL_MS) if no run refreshes it; only health.ts writes it.
      "packages/broker/src/test-env/health.ts",
      // 2026-11-02, testenv-apply (TE-2): a proposal's candidate check record (`TEST_ENV_CANDIDATE_CHECK`, one item per project, digest and settings revision) expires with the proposal it checks (7 days); only commitSetupCheck (project-setup-check.ts) writes it, and test-env-candidate.ts reads it.
      "packages/broker/src/org/test-env-candidate.ts",
      // 2026-11-02, nightly-run (NH-1): a night's status row (`TEST_ENV_NIGHT`, one per project and slot: unavailable or failed, with its reason) expires after the night-status retention (TTL_MS); only night-status.ts writes it.
      "packages/broker/src/test-env/night-status.ts",
      // 2026-11-02, sh-health-wire (SH28): a proposed fix task (`TEST_ENV_PROPOSED_FIX_TASK`, written once per key, never updated) expires after 30 days (TTL_MS) if nobody starts or dismisses it; only proposed-tasks.ts writes it.
      "packages/broker/src/test-env/proposed-tasks.ts",
      // 2026-11-02, sh-setup-wire (SH12-SH15): the setup run's journal entries, its command counter, its host-ask items (31 days) and the setup-run proposal index (7 days) are working rows of one setup run, meant to expire; none is a durable record.
      // 2026-11-02, recipes-wire: revoked and rejected recipes are moved to SETUP_RECIPE_REVOKED# with an expiry; live rows never expire.
      "packages/broker/src/org/setup-recipe-store.ts",
      "packages/broker/src/rovara-code/setup-journal.ts", "packages/broker/src/rovara-code/setup-run-proposal.ts", "packages/broker/src/rovara-code/setup-command.ts", "packages/broker/src/rovara-code/setup-host-ask.ts",
      // 2026-10-31, the lanes merged into cloud/next. Each writes rows that are meant to expire, none a durable record, and each was read for that:
      // Meta repo lane E (context sources): the loaded-knowledge manifest of a run, a source's call and byte counters, the kept quotes and citations of a result, and a source change's history item.
      "packages/broker/src/developer/loaded-knowledge.ts", "packages/broker/src/context-sources/usage.ts", "packages/broker/src/context-sources/quotes.ts",
      "packages/broker/src/context-sources/store.ts", "packages/broker/src/context-sources/citations.ts",
      // Meta repo lane F (intake): the poll's hourly read counter, a ticket waiting (30-day) or started (shorter) item, and the person's intake notices.
      "packages/broker/src/triggers/poll-intake.ts", "packages/broker/src/intake/store.ts", "packages/broker/src/intake/notices.ts",
      // Test environment (proof and evidence): a requested change's proposal and prove report, the full-suite follow-up run rows, the nightly slot claims, locks and baseline history.
      "packages/broker/src/org/test-environment.ts", "packages/broker/src/rovara-code/full-suite-followup.ts", "packages/broker/src/test-env/nightly.ts",
      // Test environment (wire-testenv): the draft environment a setup draft run reported, kept as long as a proposal is (a week); the revision a task pinned, kept as long as its evidence (400 days).
      "packages/broker/src/test-env/draft.ts", "packages/broker/src/test-env/usable.ts",
      // Rovara Code: the used marker of a setup consent; decision cards: the evidence-opened marker and a decided card's record (400 days); live steer: the outbox row of a steer message.
      "packages/broker/src/rovara-code/setup-consent.ts", "packages/broker/src/decisions/store.ts", "packages/broker/src/agent-sessions/live-steer.ts",
      // Team record (Enterprise): its own table, with its own TTL on the same attribute name (infra/lib/team-record-table.ts); rows leave the hot table a grace period after `hotExpiresAt` so the archiver can copy them first.
      "packages/broker/src/team-record/item-head.ts", "packages/broker/src/team-record/retention.ts", "packages/broker/src/team-record/scope-work.ts",
      "packages/broker/src/team-record/query.ts", "packages/broker/src/team-record/ingest.ts", "packages/broker/src/team-record/store.ts",
      "packages/contracts/src/team-record.ts", "infra/lib/team-record-table.ts",
      // 2026-11-02, team-record-links (S2): the prior-edit mark (`PRIOREDIT#<hash of the item>`, a hash and a time, no words) left when a change to an item was not stored expires after 400 days; only prior-edits.ts writes it.
      "packages/broker/src/team-record/prior-edits.ts",
      // 2026-11-02, team-record-links: the admin tracker-people request receipt (`TEAM_RECORD_TRACKER_REQUEST`, a digest of the change and its outcome, no names) expires after 90 days; runtime.ts writes it when it remembers a request.
      "packages/broker/src/team-record/runtime.ts",
      // 2026-11-03: 0.5.2 batch (fix/team-record-connect). The Jira organization admin key change reads the request receipt (`agentRequestKey` item) and its expiry to answer a repeat of the same request; the receipt expires with the TTL, nothing durable.
      "packages/broker/src/connections/store.ts",
      // Track record (v1.2 slice 1): a pending outcome sample lasts a year, a scored one and its scored copy 180 days after the score; only outcomes.ts writes and reads them.
      "packages/broker/src/rovara-code/outcomes.ts",
      // Track record hooks: the small pointer item that says where a candidate's samples are (a task's `OUTCOME_KEYS#<round>` item) expires with the pending samples, a year after it is made.
      "packages/broker/src/rovara-code/outcome-hooks.ts",
      // v1.2 learning loop (B1): corrections, their source records, dismissed patterns and ended suggestions are kept 180 days, then deleted by the TTL (named environments) or by
      // the learning sweep (a table without one). The contract names the field on the items, retention.ts judges it, store.ts writes it, sweep.ts reads it to delete. Nothing else may.
      "packages/contracts/src/project-learning.ts", "packages/broker/src/learning/retention.ts", "packages/broker/src/learning/store.ts", "packages/broker/src/learning/sweep.ts",
      // B6: a dismissed pattern carries the same 180-day expiry when Dismiss writes it.
      "packages/broker/src/learning/decide.ts",
      // Intake own-write notes (a note that a write was ours, held one window plus an hour); asks (a question kept ASK_RETENTION_DAYS, its mention-index and expiry-index items, and the erase
      // pass that copies a record without the attribute); lessons (a source event's counter row, SOURCE_EVENT_TTL_DAYS). Each writes rows that are meant to expire, none a durable record.
      "packages/broker/src/intake/own-writes.ts", "packages/broker/src/agent-sessions/ask-store.ts", "packages/broker/src/agent-sessions/ask-erase.ts", "packages/broker/src/lessons/dynamo-store.ts",
      // B8: pending PR-learning proposals use the approved authority window plus cleanup TTL.
      "packages/broker/src/learning/settings.ts",
      // Second review track record (lane cr-settings): a row per answered second opinion, kept TRACK_RETENTION_DAYS (400), then removed by the TTL.
      "packages/broker/src/rovara-code/second-review-track.ts",
      // Saved project images: the start marker of a rebuild job and a closed build workspace's record expire after 30 days; only this file writes either expiry.
      "packages/broker/src/test-env/saved-env-markers.ts",
      // 2026-11-03, chain merge: automatic runs. Their claim, month counter, started, ended and paused markers expire 62 days after they are written (cap.ts, start.ts, end.ts) and a run's watch 14 days (end.ts); each is a marker, none a durable record (the audit event is).
      "packages/broker/src/automatic-runs/start.ts", "packages/broker/src/automatic-runs/end.ts", "packages/broker/src/automatic-runs/cap.ts",
      // The Ask-in-Linear scrub: a comment kept after the tries ran out (400 days) and the resume cursor of the fix pass (30 days) expire by the TTL.
      "packages/broker/src/agent-sessions/ask-linear-scrub.ts",
      // 2026-11-03, DR7 slice A (design review): the packets built for a round's reviewer slots and the sealed key minted for each slot are working rows of one design-review operation; both expire a day after they are written (SLOT_PACKET_TTL_SECONDS) and are removed when the round is recorded. Only packet-store.ts and slot-keys.ts write them.
      "packages/broker/src/design-review/packet-store.ts", "packages/broker/src/design-review/slot-keys.ts",
      // 2026-11-04, 0.5.5 integration: task spending-stop review snapshots (admin-v11-finish) last 5 minutes, the team record's source request receipts (24 h, source-store.ts), picker listing sessions (15 min, source-options.ts) and erase sweep markers (erase.ts) are working rows of one operation each; all expire by the TTL, none is a durable record.
      "packages/broker/src/org/task-stop-enrollment.ts", "packages/broker/src/team-record/source-store.ts", "packages/broker/src/team-record/source-options.ts", "packages/broker/src/team-record/erase.ts",
      // 0.5.7 (SRL-6): the Health page's failure counters (one item per company, kind and hour) expire two days after the last failure; each is a count, none a durable record, and only ops-failures.ts writes them.
      "packages/broker/src/team-record/ops-failures.ts",
    ]);
    const found = execFileSync("grep", ["-rl", "indexExpiresAt\\|INDEX_EXPIRY_ATTRIBUTE", "packages", "infra/lib", "--include=*.ts", "--exclude-dir=dist", "--exclude-dir=node_modules"], { encoding: "utf8" }).trim().split("\n").filter((file) => file !== "");
    expect(found.filter((file) => !allowed.has(file))).toEqual([]);
  });

  it("sets the TTL attribute in broker.ts on the channel-operation marker, workflow dispatch rows and Slack refusal notes alone, and in the notifier on NOTICE items alone (25c note 2, gap 6, Task 19)", () => {
    const broker = readBrokerSource();
    const brokerUses = broker.split("\n").filter((line) => /indexExpiresAt\(|INDEX_EXPIRY_ATTRIBUTE\]/.test(line));
    expect(brokerUses).toEqual([
      "        slackUserId: user.data, channelId: thread.data.channelId, threadTs: thread.data.threadTs, message, at, [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(at) },",
      // Plan 2, Task 16: a project creation request's record, which expires with its day (it holds the same instant as its expiresAt).
      "          Item: { ...requestKey, entityType: \"PROJECT_CREATE_REQUEST\", by: caller.developerId, bodyHash, projectName: definition.name, createdAt, expiresAt, [INDEX_EXPIRY_ATTRIBUTE]: expiresAt },",
      // 2026-11-02, live-fixes (N1): the marker that a refused Slack Ask question was answered with its saved reply, so a redelivery is not read as a new question; it lives two days, then the TTL deletes it.
      "    await dependencies.documentClient.send(new PutCommand({ TableName: dependencies.tableName, Item: { ...slackAskRefusedKey(taskId, noteTs), entityType: \"SLACK_ASK_REFUSED\", [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.now() / 1000) + 2 * 86_400 } }));",
      "      [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(operation.createdAt),",
      // T7c: the held plan's marker (a small item the recovery sweep reads), always given a TTL; every finish deletes it, the TTL is only the backstop.
      "        [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(planHold.deadlineAt) / 1000) + 7 * 86_400 } } }]",
    ]);
    const holdMarker = broker.slice(broker.indexOf("// The hold's own marker"), broker.indexOf("// The hold's own marker") + 700);
    expect(holdMarker).toContain('entityType: "PLAN_GROUNDING_HOLD"');
    expect(holdMarker).toContain(brokerUses.at(-1));
    // Task 19: a refused Slack press's private note, delivered within the hour and then dead weight.
    const refusal = broker.slice(broker.indexOf("async function recordSlackWorkflowRefusal("), broker.indexOf("async function answerSlackWorkflowEvent("));
    expect(refusal).toContain('entityType: "WORKFLOW_ACTION_REFUSAL"');
    expect(refusal).toContain(brokerUses.shift());
    const projectCreation = broker.slice(broker.indexOf("async function createCloudProject("), broker.indexOf("async function createProjectSetupAdmissionRows("));
    expect(projectCreation).toContain('entityType: "PROJECT_CREATE_REQUEST"');
    expect(projectCreation).toContain(brokerUses.shift());
    expect(brokerUses.shift()).toContain('entityType: "SLACK_ASK_REFUSED"');
    const channelOperation = broker.slice(broker.indexOf("function channelOperation("), broker.indexOf("function requesterOf("));
    expect(channelOperation).toContain('entityType: "CHANNEL_OPERATION"');
    expect(channelOperation).toContain(brokerUses[0]);
    // Gap 6: a backstop for a workflow dispatch row that is somehow never resolved (the sweep gives up long before).
    const shared = readFileSync("packages/broker/src/aws/broker-shared.ts", "utf8");
    const dispatchItem = shared.slice(shared.indexOf("export function workflowDispatchItem("));
    expect(dispatchItem).toContain('entityType: "WORKFLOW_DISPATCH"');
    expect(shared.split("\n").filter((line) => /indexExpiresAt|INDEX_EXPIRY_ATTRIBUTE/.test(line)).map((line) => line.trim())).toEqual([
      'import { INDEX_EXPIRY_ATTRIBUTE, OPERATION_PROMPT_MAX_BYTES, PLAN_DOCUMENT_INFO_STRING, PLAN_PARTS_SENTENCE, type PlanDocumentKind } from "@agentx/contracts";',
      "indexExpiresAt: number;",
      // Plan 3, Task 22: the agent-step engine's dispatch row, written over the task's one row at each change; it expires a week after it was due.
      "[INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(input.dueAt) / 1000) + WORKFLOW_DISPATCH_RETENTION_SECONDS,",
      // Plan 6 Task 4: a watchdog row (Understand's) is due later than it is written, so its backstop counts from when it is due.
      "[INDEX_EXPIRY_ATTRIBUTE]: Math.floor(Date.parse(dueAt) / 1000) + WORKFLOW_DISPATCH_RETENTION_SECONDS,",
    ]);
    const notifier = readFileSync("packages/broker/src/aws/developer-task-notifier.ts", "utf8");
    const writes = notifier.split("\n").filter((line) => line.includes("noticeExpiry(deps)"));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    for (const line of writes) expect(line).toMatch(/entityType: "NOTICE"|":expires": noticeExpiry/);
    // Nothing else in the notifier names the attribute: no other item there can carry it.
    const named = notifier.split("\n").filter((line) => /indexExpiresAt|INDEX_EXPIRY_ATTRIBUTE/.test(line)).map((line) => line.trim());
    expect(named).toHaveLength(6);
    expect(named[0]).toMatch(/^import \{ INDEX_EXPIRY_ATTRIBUTE, .*indexExpiresAt, .*\} from "@agentx\/contracts";$/);
    expect(named.slice(1)).toEqual([
      "const noticeExpiry = (deps: NotifierDependencies) => ({ [INDEX_EXPIRY_ATTRIBUTE]: indexExpiresAt(new Date(deps.now()).toISOString()) });",
      'ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },',
      'ExpressionAttributeValues: { ":notice": "NOTICE", ":until": until, ":now": deps.now(), ":expires": noticeExpiry(deps)[INDEX_EXPIRY_ATTRIBUTE] },',
      // Task 17: the claim on a message's words (a NOTICE item too) expires the same way.
      'ExpressionAttributeNames: { "#expires": INDEX_EXPIRY_ATTRIBUTE },',
      '":expires": noticeExpiry(deps)[INDEX_EXPIRY_ATTRIBUTE] },',
    ]);
  });

  it("sets the TTL attribute on the baseline round's record alone, in its own module, and refreshes it with every write of that record (Task 3.7b, D4)", () => {
    const baseline = readFileSync("packages/broker/src/aws/workflow-e2e-baseline.ts", "utf8");
    const named = baseline.split("\n").filter((line) => /indexExpiresAt|INDEX_EXPIRY_ATTRIBUTE/.test(line)).map((line) => line.trim());
    expect(named[0]).toMatch(/^import \{ .*INDEX_EXPIRY_ATTRIBUTE.*indexExpiresAt.* \} from "@agentx\/contracts";$|^import \{ .*indexExpiresAt.*INDEX_EXPIRY_ATTRIBUTE.* \} from "@agentx\/contracts";$/);
    expect(baseline).toContain('entityType: "WORKFLOW_E2E_BASELINE"');
    // Every write of the record carries a fresh expiry, and the module writes no other kind of item.
    const writes = baseline.split("\n").filter((line) => /new (Put|Update)Command|Update: \{/.test(line));
    expect(writes.length).toBeGreaterThanOrEqual(4);
    const expiryWrites = baseline.split("\n").filter((line) => /\[INDEX_EXPIRY_ATTRIBUTE\]|#expires|":expires"/.test(line));
    expect(expiryWrites.length).toBeGreaterThanOrEqual(4);
    expect(baseline.match(/entityType: "[A-Z0-9_]+"/g)?.every((match) => match === 'entityType: "WORKFLOW_E2E_BASELINE"')).toBe(true);
  });

  it("expires only retired or quarantined recovery rows, while active retries stay due without TTL", () => {
    const recovery = readFileSync("packages/broker/src/aws/workflow-merge-recovery.ts", "utf8");
    expect(recovery).toContain("const RETIRED_TTL_SECONDS = 7 * 24 * 60 * 60;");
    const quarantineStart = recovery.indexOf("async function quarantine(");
    const quarantineEnd = recovery.indexOf("async function claimRow(", quarantineStart);
    expect(quarantineStart).toBeGreaterThanOrEqual(0);
    expect(quarantineEnd).toBeGreaterThan(quarantineStart);
    const quarantine = recovery.slice(quarantineStart, quarantineEnd);
    expect(quarantine).toContain("recoveryStatus = :status");
    expect(quarantine).toContain("indexExpiresAt = :ttl REMOVE nextAttemptAt, dispatchDuePk, dispatchDueSk");
    const retire = recovery.slice(recovery.indexOf("async function retire("), recovery.indexOf("async function setGlobalCooldown("));
    expect(retire).toContain("recoveryStatus = :status, retiredAt = :now, updatedAt = :now, indexExpiresAt = :ttl");
    const retry = recovery.slice(recovery.indexOf("async function settleActive("), recovery.indexOf("async function retire("));
    expect(retry).toContain("SET attempts = :attempts, nextAttemptAt = :next, dispatchDueSk = :due, updatedAt = :now REMOVE leaseToken, leaseExpiresAt");
    expect(retry).not.toContain("indexExpiresAt");
  });

  it("adds nothing to the legacy template", () => {
    expect(brokerStatements(legacy).some((statement) => statement.Action === "cloudwatch:DescribeAlarms" || statement.Action === "sqs:GetQueueAttributes")).toBe(false);
    const legacyTables = Object.values(legacy.findResources("AWS::DynamoDB::Table") as Record<string, { Properties: { StreamSpecification?: unknown; TimeToLiveSpecification?: unknown } }>);
    expect(legacyTables.find((table) => table.Properties.StreamSpecification !== undefined)?.Properties.TimeToLiveSpecification).toBeUndefined();
    expect(brokerEnvironment(legacy)).not.toHaveProperty("AGENTX_ALARM_PREFIX");
    expect(brokerEnvironment(legacy)).not.toHaveProperty("HEALTH_DEAD_LETTER_QUEUES");
  });
});

it("uses the shared State TTL attribute for reviewed company role receipts", () => {
 const source = readFileSync("packages/broker/src/org/role-changes.ts", "utf8");
 expect(source).toContain("[INDEX_EXPIRY_ATTRIBUTE]");expect(source).not.toMatch(/\bindexExpiresAt\s*:/);
});
