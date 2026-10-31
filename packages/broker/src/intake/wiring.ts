// Meta repo lane F (F1): the broker's own functions behind `IntakePorts`, so that `engine.ts` can be tested with others. Who a tracker account is comes only from a link the org holds
// (GitHub: the account-to-member link of `rovara-code/github-members.ts`; another tracker: a resolver its adapter registers); the member is read live (sign-in, revocation,
// membership), and so is their role on the project (`roleOnProject`, `requireNewWorkAllowed`). The start is `startCodeIntent` as that member, so the project role, the company's
// rules, the payer and the budget are the ones that already exist; nothing here decides money or access.
import { AgentXError, agentXError, type CodeIntentRequest, type OrgId } from "@agentx/contracts";
import { sessionForSurface } from "../agent-sessions/bindings.js";
import { roleOnProject } from "../agents/roster.js";
import type { AgentRunStarter } from "../agents/runs.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { requireNewWorkAllowed } from "../developer/project-roles.js";
import { memberForGithubUser } from "../rovara-code/github-members.js";
import { startCodeIntent, type CodeIntentDependencies } from "../rovara-code/intent.js";
import type { IntakePorts } from "./engine.js";

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
  accountResolvers?: Readonly<Record<string, (orgId: OrgId, accountId: string) => Promise<string | undefined>>> | undefined;
  /** Tells the project's maintainers once that waiting tickets are not being stored (optional). */
  notifyWaitingFull?: IntakePorts["notifyWaitingFull"];
}

const isPassing = (error: unknown): boolean => error instanceof AgentXError && error.statusCode < 500;

/** The ports of an intake engine, over the broker's own dependencies. */
export function intakePortsOf(wiring: IntakeWiring): IntakePorts {
  const table = { documentClient: wiring.documentClient, tableName: wiring.tableName, now: wiring.now };
  const log = wiring.log ?? ((event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event, ...fields })));
  return {
    table,
    log,
    memberOfAccount: async (orgId, system, accountId) => {
      const resolve = system === "github"
        ? (org: OrgId, account: string) => memberForGithubUser({ documentClient: wiring.documentClient, tableName: wiring.tableName, now: wiring.now }, org, account)
        : wiring.accountResolvers?.[system];
      const developerId = resolve === undefined ? undefined : await resolve(orgId, accountId);
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
      return startCodeIntent(wiring.intentDependenciesFor(caller), caller, request);
    },
    sessionOfTicket: async (orgId, binding) => {
      const session = await sessionForSurface(table, orgId, binding);
      return session === undefined ? undefined : { sessionId: session.sessionId };
    },
    ...(wiring.notifyWaitingFull === undefined ? {} : { notifyWaitingFull: wiring.notifyWaitingFull }),
  };
}
