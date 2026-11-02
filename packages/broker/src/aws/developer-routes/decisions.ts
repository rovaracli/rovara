// Decision cards (wire-proof, setup wizard E4): what the card routes (`decisions/routes.ts`) need for one caller, built from the developer route dependencies. It exists only while the cards switch is on: with it off this returns
// undefined, the paths fall through as any unknown path, and nothing here reads or writes anything.
//
// What is connected, and what is not:
//   merge        the caller's own tasks waiting for their pull requests to be merged (decisions/merge-source.ts). Approve goes through `pressMerge`, the Merge button's own endpoint: it re-checks the caller's authority and
//                readiness, refuses a head that moved since the card, never merges on a click at HIGH risk or for a token (it answers the confirmation page, which asks for a sign-in within the last 10 minutes), and
//                merges at once only for a live browser session at low or medium risk, as the button does.
//   spec_choice  a task whose spec is on hold (open only; the choice is made on the task page).
//   approve_test_env    a project's proved test environment proposal waiting for a maintainer (decisions/test-env-source.ts). Approve is the setup wizard's own approval; a high-risk or less-safe one has no approve
//                       action and opens the setup page, where the fresh sign-in and the second person are asked for.
//   confirm_env_change  a running task's owner moves the task onto a newer approved test environment, when the change is one a running task takes; "Not now" keeps the task where it is.
//   fix_setup           (SH17, only while `vx` is on) a project's test environment, not its code, kept tasks' checks from giving a verdict (test-env/fix-setup.ts). The card is for the project's maintainers. Approve is "Mark as
//                       known failing" (adds the record's own tests to the project's already-failing set), "Not now" puts the card away; Run setup agent, Fix with agent and Retry task checks are on the pages it opens.
//   NOT connected: spend requests (`decideSpendRequest` is reachable only through the decide page's fresh sign-in; a card press would decide one with no sign-in proof, so Home's own card stays), and plan,
//   requirements, design, dependency, E2E plan, feedback, autofix, setting and test-environment decisions (their endpoints live in hot task files and stay page-decided). An unregistered kind is refused `unsupported`.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { projectAllows } from "@agentx/contracts";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { AgentSessionStore } from "../../agent-sessions/store.js";
import { createDecisionPerformer, envChangeHandler, fixSetupHandler, mergeHandler, testEnvHandler } from "../../decisions/performer.js";
import { dismissFixSetup, fixSetupItemsFor, markKnownFailing } from "../../test-env/fix-setup.js";
import { answerEnvChange, approveTestEnvItemsFor, envChangeItemsFor } from "../../decisions/test-env-source.js";
import { liveTestEnvCard } from "../../org/test-env-approval.js";
import { mayDecideApproval } from "../../agents/approvals.js";
import { nightlyHooks } from "../../test-env/nightly-wiring.js";
import { approveChecked, testEnvStoreOf } from "./test-environment.js";
import { visibleProjectRoles } from "./project-list.js";
import { dynamoDecisionStore } from "../../decisions/store.js";
import { mergeItemsFor } from "../../decisions/merge-source.js";
import type { DecisionRouteDependencies } from "../../decisions/routes.js";
import { pressMerge } from "../../rovara-code/merge.js";
import { readMergeTracking } from "../../rovara-code/merge-tracking.js";
import { decisionCardsEnabled } from "../../proof/switch.js";
import { specChoiceItemsFor } from "../developer-tasks/spec-wiring.js";
import { developerTaskRouteDependencies, sessionDependenciesOf, sessionReadDependencies } from "./dependencies.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const DECISION_PATH = /^\/v1\/app\/decisions(?:\/|$)/u;
export const isDecisionPath = (pathname: string): boolean => DECISION_PATH.test(pathname);

/** The card routes' dependencies for one caller, or undefined while the switch is off or where sessions, tasks or agents are not set up (fail closed). */
export function decisionRouteDepsOf(deps: DeveloperRouteDependencies, caller: DeveloperCaller, env: NodeJS.ProcessEnv = process.env): DecisionRouteDependencies<DeveloperCaller> | undefined {
  if (!decisionCardsEnabled(env)) return undefined;
  const sessions = sessionDependenciesOf(deps);
  const agents = deps.agents;
  if (sessions === undefined || deps.tasks === undefined || agents === undefined) return undefined;
  const table = { documentClient: deps.documentClient, tableName: deps.tableName };
  const taskDeps = (who: DeveloperCaller) => developerTaskRouteDependencies(deps, who);
  // Test environment (E4): the cards of the proposals waiting for a maintainer, and of the running tasks that can take a newer revision. Both are empty while the test-environment switch is off.
  const store = testEnvStoreOf(deps);
  const loadTask = async (taskId: string) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item;
  const testEnvCards = {
    store,
    maintainedProjects: async (who: { orgId: string; developerId: string }) => [...(await visibleProjectRoles(deps, who as DeveloperCaller)).entries()].filter(([, role]) => projectAllows(role, "edit_settings")).map(([name]) => name).sort(),
    confirmPathOf: async (who: { orgId: string; developerId: string }, scope: { project: string; digest: string; expectedRevision: number }) => {
      if (deps.agents === undefined) return undefined;
      const { card } = await liveTestEnvCard(deps.agents, { orgId: who.orgId, ...scope, askedBy: who.developerId });
      return card.state === "pending" && card.record !== undefined && card.approvalId !== undefined && await mayDecideApproval(deps.agents, who as DeveloperCaller, card.record) ? `/v1/app/approve/${card.approvalId}` : undefined;
    },
  };
  // Setup and test health (SH17): the Fix setup cards of the projects the caller maintains, and the live check of that authority when one is decided. Empty while `vx` is off.
  const mayEditSettings = async (who: { orgId: string; developerId: string }, project: string): Promise<boolean> => {
    const role = (await visibleProjectRoles(deps, who as DeveloperCaller)).get(project);
    return role !== undefined && projectAllows(role, "edit_settings");
  };
  const fixSetupPorts = { store, mayEditSettings };
  return {
    sources: {
      async list(who) {
        const [merges, specs, testEnv, envChanges, fixSetup] = await Promise.all([
          mergeItemsFor({
            ...table, now: deps.now,
            sessionIdOf: async (task) => (await new AgentSessionStore(sessions).getForTask(who.orgId, task))?.sessionId,
            task: async (taskId) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item,
            tracking: (taskId, orgId) => readMergeTracking(table, taskId, orgId as never),
          }, who),
          specChoiceItemsFor(taskDeps(who), who),
          approveTestEnvItemsFor(testEnvCards, who),
          envChangeItemsFor({ store, task: loadTask }, who),
          fixSetupItemsFor({ store, maintainedProjects: testEnvCards.maintainedProjects, task: loadTask }, who),
        ]);
        return [...merges, ...specs, ...testEnv, ...envChanges, ...fixSetup];
      },
      // Company locks that raise a card's tier are not stored anywhere yet: none apply, so the tiers are the projector's own.
      async locks() { return {}; },
    },
    performer: createDecisionPerformer<DeveloperCaller>({
      merge: mergeHandler((who, sessionId, body, expectedHeads) => pressMerge(sessionReadDependencies(deps, who), who, sessionId, body, agents, { expectedHeads })),
      approve_test_env: testEnvHandler(async (who, item, requestId) => {
        const role = (await visibleProjectRoles(deps, who)).get(item.project);
        await approveChecked(deps, who, role, item.project, { digest: item.digest, expectedRevision: item.expectedRevision, requestId }, nightlyHooks());
      }),
      confirm_env_change: envChangeHandler((who, taskId, answer) => answerEnvChange({ store, task: loadTask }, who, taskId, answer)),
      fix_setup: fixSetupHandler({
        markKnownFailing: (who, item, requestId) => markKnownFailing(fixSetupPorts, who, item, requestId),
        dismiss: (who, item) => dismissFixSetup(fixSetupPorts, who, item),
      }),
    }),
    store: dynamoDecisionStore({ ...table, now: deps.now }),
    now: deps.now,
    log: (measure) => console.log(JSON.stringify({ component: "broker", ...measure })),
  };
}
