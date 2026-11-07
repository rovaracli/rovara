// Meta repo lane F (F1): the broker's own functions behind `IntakePorts`, so that `engine.ts` can be tested with others. Who a tracker account is comes only from a link the org holds
// (GitHub: the account-to-member link of `rovara-code/github-members.ts`; Linear and Jira: the company's tracker links, `identity.ts`; another tracker: a resolver its adapter registers); the member is read live (sign-in, revocation,
// membership), and so is their role on the project (`roleOnProject`, `requireNewWorkAllowed`). The start is `startCodeIntent` as that member, so the project role, the company's
// rules, the payer and the budget are the ones that already exist; nothing here decides money or access.
import { AgentXError, agentXError, type CodeIntentRequest, type OrgId } from "@agentx/contracts";
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { agentSessionKey, SessionIdSchema } from "@agentx/contracts";
import { sessionForSurface, unbindSessionSurface } from "../agent-sessions/bindings.js";
import { isEnded } from "../agent-sessions/stop.js";
import { roleOnProject } from "../agents/roster.js";
import type { AgentRunStarter } from "../agents/runs.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { memberForGithubUser } from "../rovara-code/github-members.js";
import { designFirstRequestOf, markDesignFirst } from "../design-review/design-first.js";
import { startCodeIntent, type CodeIntentDependencies } from "../rovara-code/intent.js";
import type { TeamRecordTable } from "../team-record/types.js";
import type { IntakePorts } from "./engine.js";
import { trackerAccountResolvers, type TrackerAccountResolver } from "./identity.js";
import { noteTicketTaskStarted } from "../ticket-updates/moments.js";

export interface IntakeWiring {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  log?: ((event: string, fields: Record<string, unknown>) => void) | undefined;
  /** Plan 3's run start: it reads a member as a caller in the org, live. */
  starter: AgentRunStarter;
  /** What `startCodeIntent` needs for one caller. */
  intentDependenciesFor(caller: DeveloperCaller): CodeIntentDependencies;
  /** The accounts of a tracker other than GitHub that a member linked, by system. A tracker with no resolver has no member: its tickets wait for a member to say "Start". */
  accountResolvers?: Readonly<Record<string, TrackerAccountResolver>> | undefined;
  /** Slice 5: the Team record's table, where the company's Linear and Jira links live. Given (and no `accountResolvers`), Linear and Jira accounts resolve through those links (`identity.ts`). */
  trackerLinks?: TeamRecordTable | undefined;
  /** Tells the project's maintainers once that waiting tickets are not being stored (optional). */
  notifyWaitingFull?: IntakePorts["notifyWaitingFull"];
}

const isPassing = (error: unknown): boolean => error instanceof AgentXError && error.statusCode < 500;

/** The ports of an intake engine, over the broker's own dependencies. */
export function intakePortsOf(wiring: IntakeWiring): IntakePorts {
  const table = { documentClient: wiring.documentClient, tableName: wiring.tableName, now: wiring.now };
  const log = wiring.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));
  const resolvers = wiring.accountResolvers ?? (wiring.trackerLinks === undefined ? undefined : trackerAccountResolvers(wiring.trackerLinks));
  return {
    table,
    log,
    memberOfAccount: async (orgId, system, accountId, ticketUrl) => {
      const resolve: TrackerAccountResolver | undefined = system === "github"
        ? (org: OrgId, account: string) => memberForGithubUser({ documentClient: wiring.documentClient, tableName: wiring.tableName, now: wiring.now }, org, account)
        : resolvers !== undefined && Object.hasOwn(resolvers, system) ? resolvers[system] : undefined;
      const developerId = resolve === undefined ? undefined : await resolve(orgId, accountId, ticketUrl);
      if (developerId === undefined) return undefined;
      // Read live: a person who is revoked, removed or in another org is nobody here.
      return await wiring.starter.callerFor(orgId, developerId) === undefined ? undefined : developerId;
    },
    mayStart: async (orgId, developerId, project) => {
      const caller = await wiring.starter.callerFor(orgId, developerId);
      if (caller === undefined) return false;
      try {
        const role = await roleOnProject(wiring.starter, caller, project);
        await requireNewWorkAllowed(wiring.starter, orgId, project, role, "task");
        return true;
      } catch (error) {
        // A role that does not start tasks, a project that is not theirs or is archived: no. A read that failed is the delivery's to repeat.
        if (isPassing(error)) return false;
        throw error;
      }
    },
    start: async (orgId, developerId, request: CodeIntentRequest) => {
      const caller = await wiring.starter.callerFor(orgId, developerId);
      if (caller === undefined) throw agentXError("FORBIDDEN", "The person this run is for isn't a member of the organization.");
      // `design first:` at the start of the ticket's text (DR11): the prefix is the person's ask, not part of the request; it is recorded on the task once it exists.
      const first = request.input.text === undefined ? { designFirst: false, rest: "" } : await designFirstRequestOf(table, orgId, request.input.text);
      const started = await startCodeIntent(wiring.intentDependenciesFor(caller), caller, first.designFirst ? { ...request, input: { ...request.input, text: first.rest } } : request);
      if (first.designFirst) await markDesignFirst(table, started.task.taskId, developerId);
      return started;
    },
    sessionOfTicket: async (orgId, binding) => {
      const session = await sessionForSurface(table, orgId, binding);
      return session === undefined ? undefined : { sessionId: session.sessionId, ended: isEnded(session) };
    },
    // A ticket asked for again after its task ended: the ended session lets go of the ticket (its binding and the surface item), as the Linear "free the surface" step does.
    freeTicket: async (orgId, sessionId) => {
      await unbindSessionSurface(table, { orgId, sessionId: SessionIdSchema.parse(sessionId), kind: "tracker_item" });
    },
    // The new session points back to the one it follows (`retryOf`, written only if it has none).
    linkPrevious: async (orgId, nextSessionId, previousSessionId) => {
      try {
        await wiring.documentClient.send(new UpdateCommand({
          TableName: wiring.tableName, Key: agentSessionKey(orgId, SessionIdSchema.parse(nextSessionId), "META"), UpdateExpression: "SET retryOf = :old ADD #revision :one",
          ConditionExpression: "attribute_exists(pk) AND orgId = :org AND attribute_not_exists(retryOf)", ExpressionAttributeNames: { "#revision": "revision" },
          ExpressionAttributeValues: { ":old": SessionIdSchema.parse(previousSessionId), ":one": 1, ":org": orgId },
        }));
      } catch (error) {
        if (!(error instanceof Error && error.name === "ConditionalCheckFailedException")) throw error;
      }
    },
    ...(wiring.notifyWaitingFull === undefined ? {} : { notifyWaitingFull: wiring.notifyWaitingFull }),
    // Slice 5: the ticket hears that work started (a `started` milestone; the ticket updates handler decides whether to write).
    started: async (orgId, started) => { await noteTicketTaskStarted({ ...table, log }, { orgId, taskId: started.taskId, sessionId: started.sessionId }); },
  };
}
