// Every scenario, one per file. A new scenario is a file here and a line in this list, or a lane's file `<lane>-<what>.ts` listed in its `index-<lane>.ts` (tests/parity/parity.test.ts checks that every file is listed).

import quickToPlanReview from "./quick-to-plan-review.js";
import planChangesRequested from "./plan-changes-requested.js";
import approveToDraftPr from "./approve-to-draft-pr.js";
import checkFailsAutofix from "./check-fails-autofix.js";
import reviewFindingsSendBack from "./review-findings-send-back.js";
import stopAtPlanReview from "./stop-at-plan-review.js";
import prMerged from "./pr-merged.js";
import spendLimitHit from "./spend-limit-hit.js";
import approvalGiven from "./approval-given.js";
import approvalRefused from "./approval-refused.js";
import sessionMessageMidRun from "./session-message-mid-run.js";
import twoActorsRace from "./two-actors-race.js";
import workerLost from "./worker-lost.js";
import baseBranchDrift from "./base-branch-drift.js";
import mergeConflict from "./merge-conflict.js";
import decisionTimeout from "./decision-timeout.js";
import erasure from "./erasure.js";
import multiProjectCompany from "./multi-project-company.js";
import understandQuestions from "./understand-questions.js";
import secondReview from "./second-review.js";
import designReview from "./design-review.js";
import e2eChecks from "./e2e-checks.js";
import parallelParts from "./parallel-parts.js";
import lessons from "./lessons.js";
import trackerIntake from "./tracker-intake.js";
import notifications from "./notifications.js";
import slackChannel from "./slack-channel.js";
import modelSelection from "./model-selection.js";
import auditLedger from "./audit-ledger.js";
import savedEnvironment from "./saved-environment.js";
import testServices from "./test-services.js";
import setupAgent from "./setup-agent.js";
import devcontainer from "./devcontainer.js";
import playbook from "./playbook.js";
import diagnosis from "./diagnosis.js";
import connections from "./connections.js";
import mcpTools from "./mcp-tools.js";
import scriptTokens from "./script-tokens.js";
import realtime from "./realtime.js";
import outboundEvents from "./outbound-events.js";
import planWithoutTestStatement from "./plan-without-test-statement.js";
import codeDefaultsQuick from "./code-defaults-quick.js";
import checkFailsBlocks from "./check-fails-blocks.js";
import type { Scenario } from "../harness/types.js";
import { MERGE_SCENARIOS } from "./index-merge.js";
import { PEOPLE_MONEY_SCENARIOS } from "./index-people-money.js";
import { RESILIENCE_SCENARIOS } from "./index-resilience.js";
import { FACETS_SCENARIOS } from "./index-facets.js";
import { FEATURES_A_SCENARIOS } from "./index-features-a.js";
import { FEATURES_B_SCENARIOS } from "./index-features-b.js";
import { FEATURES_C_SCENARIOS } from "./index-features-c.js";
import { FEATURES_D_SCENARIOS } from "./index-features-d.js";

export const SCENARIOS: readonly Scenario[] = [
  quickToPlanReview,
  planChangesRequested,
  approveToDraftPr,
  checkFailsAutofix,
  reviewFindingsSendBack,
  stopAtPlanReview,
  prMerged,
  spendLimitHit,
  approvalGiven,
  approvalRefused,
  sessionMessageMidRun,
  twoActorsRace,
  workerLost,
  baseBranchDrift,
  mergeConflict,
  decisionTimeout,
  erasure,
  multiProjectCompany,
  understandQuestions,
  secondReview,
  designReview,
  e2eChecks,
  parallelParts,
  lessons,
  trackerIntake,
  notifications,
  slackChannel,
  modelSelection,
  auditLedger,
  savedEnvironment,
  testServices,
  setupAgent,
  devcontainer,
  playbook,
  diagnosis,
  connections,
  mcpTools,
  scriptTokens,
  realtime,
  outboundEvents,
  planWithoutTestStatement,
  codeDefaultsQuick,
  checkFailsBlocks,
  ...MERGE_SCENARIOS,
  ...PEOPLE_MONEY_SCENARIOS,
  ...RESILIENCE_SCENARIOS,
  ...FACETS_SCENARIOS,
  ...FEATURES_A_SCENARIOS,
  ...FEATURES_B_SCENARIOS,
  ...FEATURES_C_SCENARIOS,
  ...FEATURES_D_SCENARIOS,
];
