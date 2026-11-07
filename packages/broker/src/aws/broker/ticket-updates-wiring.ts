// Slice 5 "Outside tools" (owner decision 6): the broker's wiring of ticket updates. At broker start (`broker/handler.ts`) the milestone handler and the task end handler are registered once per
// process; each reads the dependencies of the latest broker built, and does nothing where the broker has no developer sign-in (no web link to give). The trackers are written through the company's
// own connections (`orgConnections`), the Linear writer the broker already has (`linearReply`) and the GitHub App.
import { registerTaskEndHandler } from "../../agents/task-end.js";
import { registerCodeMilestoneHandler } from "../../rovara-code/milestones.js";
import { ticketUpdatesHandler, type TicketUpdatesDependencies } from "../../ticket-updates/handler.js";
import { noteTicketPlanReady, ticketTaskEndHandler, type MomentTable } from "../../ticket-updates/moments.js";
import { ticketTrackersOf, type GitHubIssueWriter } from "../../ticket-updates/trackers.js";
import type { AwsBrokerDependencies } from "./definitions.js";

let current: TicketUpdatesDependencies | undefined;
let removeMilestone: (() => void) | undefined;
let removeEnd: (() => void) | undefined;

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields }));

/** The ticket updates dependencies from the broker's own; undefined without developer sign-in. */
export function ticketUpdatesDependenciesOf(dependencies: AwsBrokerDependencies): TicketUpdatesDependencies | undefined {
  if (dependencies.developer === undefined) return undefined;
  const github = dependencies.githubPullRequests.commentOnIssue === undefined ? undefined : dependencies.githubPullRequests as GitHubIssueWriter;
  return {
    documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, origin: new URL(dependencies.developer.issuer).origin, log,
    trackers: ticketTrackersOf({ connections: dependencies.orgConnections, linearReply: dependencies.linearReply, github }),
  };
}

/** At broker start. */
export function installTicketUpdates(dependencies: AwsBrokerDependencies): void {
  current = ticketUpdatesDependenciesOf(dependencies);
  if (current === undefined) return;
  removeMilestone ??= registerCodeMilestoneHandler(ticketUpdatesHandler(() => current));
  removeEnd ??= registerTaskEndHandler(ticketTaskEndHandler(() => current));
}

/** Takes the handlers off again (tests). */
export function uninstallTicketUpdates(): void {
  removeMilestone?.();
  removeEnd?.();
  removeMilestone = undefined;
  removeEnd = undefined;
  current = undefined;
}

/** After a worker's result committed (`terminal-result.ts`): the plan_ready moment of a task that follows a ticket. */
export async function noteTicketPlanAfterResult(dependencies: Pick<AwsBrokerDependencies, "documentClient" | "tableName">, taskId: string): Promise<void> {
  const table: MomentTable = { documentClient: dependencies.documentClient, tableName: dependencies.tableName, now: Date.now, log };
  await noteTicketPlanReady(table, taskId);
}
