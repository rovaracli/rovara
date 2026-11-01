// Decision cards (wire-proof): what the card routes (`decisions/routes.ts`) need for one caller, built from the developer route dependencies. It exists only while the cards switch is on: with it off this returns
// undefined, the paths fall through as any unknown path, and nothing here reads or writes anything.
//
// What is connected, and what is not:
//   merge        the caller's own tasks waiting for their pull requests to be merged (decisions/merge-source.ts). Approve goes through `pressMerge`, the Merge button's own endpoint: it re-checks the caller's authority and
//                readiness, refuses a head that moved since the card, never merges on a click at HIGH risk or for a token (it answers the confirmation page, which asks for a sign-in within the last 10 minutes), and
//                merges at once only for a live browser session at low or medium risk, as the button does.
//   spec_choice  a task whose spec is on hold (open only; the choice is made on the task page).
//   NOT connected: spend requests (`decideSpendRequest` is reachable only through the decide page's fresh sign-in; a card press would decide one with no sign-in proof, so Home's own card stays), and plan,
//   requirements, design, dependency, E2E plan, feedback, autofix, setting and test-environment decisions (their endpoints live in hot task files and stay page-decided). An unregistered kind is refused `unsupported`.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { taskKey, type DeveloperTaskRecord } from "../../developer/task-records.js";
import { AgentSessionStore } from "../../agent-sessions/store.js";
import { createDecisionPerformer, mergeHandler } from "../../decisions/performer.js";
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
  return {
    sources: {
      async list(who) {
        const [merges, specs] = await Promise.all([
          mergeItemsFor({
            ...table, now: deps.now,
            sessionIdOf: async (task) => (await new AgentSessionStore(sessions).getForTask(who.orgId, task))?.sessionId,
            task: async (taskId) => ((await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: taskKey(taskId), ConsistentRead: true }))) as { Item?: DeveloperTaskRecord }).Item,
            tracking: (taskId, orgId) => readMergeTracking(table, taskId, orgId as never),
          }, who),
          specChoiceItemsFor(taskDeps(who), who),
        ]);
        return [...merges, ...specs];
      },
      // Company locks that raise a card's tier are not stored anywhere yet: none apply, so the tiers are the projector's own.
      async locks() { return {}; },
    },
    performer: createDecisionPerformer<DeveloperCaller>({
      merge: mergeHandler((who, sessionId, body, expectedHeads) => pressMerge(sessionReadDependencies(deps, who), who, sessionId, body, agents, { expectedHeads })),
    }),
    store: dynamoDecisionStore({ ...table, now: deps.now }),
    now: deps.now,
    log: (measure) => console.log(JSON.stringify({ component: "broker", ...measure })),
  };
}
