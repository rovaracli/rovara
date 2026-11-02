// Setup agent routes (sh-setup-wire, SH14; design setup-test-health 3.4): `/v1/app/projects/{name}/setup-agent`, `.../stop`, `.../command` and `.../journal`. They exist only while the `su` switch is on and, with
// it off, `routeSetupAgent` answers undefined at once and the path falls through as any unknown path does (nothing is read, nothing is written). Everything the routes decide is in
// `rovara-code/setup-agent.ts` (start, stop, state), `setup-command.ts` (a person's command) and `setup-journal.ts`; this file builds their dependencies from the developer API's.
import { agentXError, ROVARA_CODE_AGENT_ID, projectAllows, type Payer } from "@agentx/contracts";
import { resolveRunPayer, startAgentRun } from "../../agents/runs.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { StatusReply } from "../status-reply.js";
import { cancelTaskFor } from "../developer-tasks.js";
import { requireNewWorkAllowed } from "../../developer/project-roles.js";
import { latestRevision } from "../../org/project-settings.js";
import { setupAgentEnabled } from "../../rovara-code/setup-agent-switch.js";
import { getSetupAgent, readState, startSetupAgent, stopSetupAgent, type SetupAgentDependencies, type SetupAgentStarter } from "../../rovara-code/setup-agent.js";
import { runSetupCommand } from "../../rovara-code/setup-command.js";
import { confirmSetupAgent, type SetupConfirmDependencies } from "../../rovara-code/setup-confirm.js";
import { listHostAsks } from "../../rovara-code/setup-host-ask.js";
import { readSetupJournal } from "../../rovara-code/setup-journal.js";
import { agentRunStarterOf, developerTaskRouteDependencies } from "./dependencies.js";
import { projectRoleForRoute } from "./project-members.js";
import { jsonBody } from "./organization.js";
import { requireFreshSignIn } from "./test-environment-wizard.js";
import { mergeDraftWithApproved, testEnvStoreOf } from "./test-environment.js";
import { proposeTestEnvironment, readApprovedTestEnvironment } from "../../org/test-environment.js";
import { testEnvironmentEnabled } from "../../test-env/switch.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

export const SETUP_AGENT_PATH = /^\/v1\/app\/projects\/([^/]+)\/setup-agent(?:\/(stop|command|journal|confirm))?$/u;

/**
 * The starter a setup run uses: the ordinary agent run start (so the person's role, the payer RULES, the allowed models, the budget floor and the run limit all apply as for any task) with the run's
 * limits, and a cancel recorded as the person who pressed Stop. The payer is NOT passed: `startAgentRun` works it out from the project's settings and holds the start to it (`payerFromRules`), the same
 * answer `payerFor` gave the route.
 */
export function setupAgentStarterOf(deps: DeveloperRouteDependencies): SetupAgentStarter | undefined {
  const starter = agentRunStarterOf(deps);
  if (starter === undefined) return undefined;
  return {
    start: (caller, request) => startAgentRun(starter, {
      requestId: request.requestId, orgId: request.orgId, project: request.project, agent: { agentId: ROVARA_CODE_AGENT_ID }, input: { text: request.text }, origin: "app",
      owner: { developerId: caller.developerId }, startedBy: { developerId: caller.developerId }, caller,
      setupAgent: { limits: request.limits, seenTaskId: request.seenTaskId },
      // One resolution: the route resolved the payer (project or the person) once; the start holds to it and answers a changed setting as busy, never charges another.
      payer: request.payer, payerFromRules: true,
    }),
    // The cancel is the stopper's own (a maintainer the route has just checked), whoever owns the run now: it works when the run's owner was removed, and the audit names the person who pressed Stop.
    cancel: async (request) => {
      await cancelTaskFor(developerTaskRouteDependencies(deps, request.stoppedBy), { taskId: request.taskId }, { requestId: request.requestId, actor: { kind: "session", caller: request.stoppedBy } });
    },
  };
}

/** The setup routes' dependencies for this install (the `su` switch is read from the environment, as every switch is). */
export function setupAgentDepsOf(deps: DeveloperRouteDependencies, env: NodeJS.ProcessEnv = process.env): SetupAgentDependencies {
  const starter = setupAgentStarterOf(deps);
  return {
    documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, enabled: setupAgentEnabled(env), starter,
    projectFor: (who, rawName) => projectRoleForRoute(deps, who, rawName),
    requireNewWork: (who, project, role) => requireNewWorkAllowed(deps, who.orgId, project, role, "task"),
    latest: async (orgId, project) => {
      const latest = await latestRevision({ documentClient: deps.documentClient, tableName: deps.tableName }, orgId, project);
      return latest === undefined ? undefined : { revision: latest.definition.revision, definition: latest.definition };
    },
    // The project's own limits and the company's lock have no stored setting yet (SH29 holds the lock; the project setting is a later screen): a run uses the defaults, which a lock could only lower.
    limitSettings: async () => ({}),
    requireFreshSignIn: async (who) => { await requireFreshSignIn(deps, who); },
    modelAccessConfigured: deps.modelAccess !== undefined,
    ...(deps.setupCitationReader === undefined ? {} : { readFile: deps.setupCitationReader }),
    payerFor: async (who, project): Promise<Payer> => {
      if (deps.agents === undefined) throw agentXError("NOT_FOUND", "setting up a project with Rovara is not set up in this deployment");
      return (await resolveRunPayer(deps.agents, { orgId: who.orgId, project, agentId: ROVARA_CODE_AGENT_ID, origin: "app", startedBy: { developerId: who.developerId } })).payer;
    },
  };
}

/**
 * Routes a setup-agent request, or answers undefined when the path is not one or the switch is off. A browser session or a token may call them: every route checks that the caller is a project
 * maintainer (`edit_settings`), and a person's command and a stop are the maintainer's own acts.
 */
export async function routeSetupAgent(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL, env: NodeJS.ProcessEnv = process.env): Promise<StatusReply | object | undefined> {
  const match = SETUP_AGENT_PATH.exec(url.pathname);
  if (match === null || !setupAgentEnabled(env)) return undefined;
  const setup = setupAgentDepsOf(deps, env);
  const name = match[1]!;
  const tail = match[2];
  if (tail === undefined && request.method === "POST") return startSetupAgent(setup, caller, name, jsonBody(request));
  if (tail === undefined && request.method === "GET") return getSetupAgent(setup, caller, name);
  if (tail === "stop" && request.method === "POST") return stopSetupAgent(setup, caller, name, jsonBody(request));
  if (tail === "command" && request.method === "POST") return runSetupCommand(setup, caller, name, jsonBody(request));
  if (tail === "journal" && request.method === "GET") return readJournalRoute(setup, caller, name, url);
  if (tail === "confirm" && request.method === "POST") return confirmSetupAgent(confirmDepsOf(deps, setup, caller, env), caller, name, jsonBody(request));
  return undefined;
}

/** The confirm step's dependencies: the test-environment store and its proposal path (the maintainer's own `editTestEnvironment`), and the approved environment the proposal keeps what a person set in. */
function confirmDepsOf(deps: DeveloperRouteDependencies, setup: SetupAgentDependencies, caller: DeveloperCaller, env: NodeJS.ProcessEnv): SetupConfirmDependencies {
  const store = testEnvStoreOf(deps);
  return {
    ...setup, testEnvironmentOn: testEnvironmentEnabled(env),
    merge: async (project, environment) => mergeDraftWithApproved(environment, (await readApprovedTestEnvironment(store, caller.orgId, project))?.environment),
    propose: async (who, project, role, environment, valueSources) => { const { digest } = await proposeTestEnvironment(store, { orgId: who.orgId, project, proposedBy: who.developerId, role, body: environment, valueSources }); return { digest }; },
  };
}

/** `GET .../setup-agent/journal?after=<n>`: the running (or last) run's journal entries after position `n`, for a maintainer. The run is the project's pointer's: never a task named by the client. */
async function readJournalRoute(setup: SetupAgentDependencies, caller: DeveloperCaller, rawName: string, url: URL): Promise<StatusReply> {
  const found = await setup.projectFor(caller, rawName);
  if (!projectAllows(found.role, "edit_settings")) throw agentXError("FORBIDDEN", "only a project maintainer can read a setup run");
  const latest = await setup.latest(caller.orgId, found.name);
  if (latest === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
  const state = await readState(setup, caller.orgId, found.name, latest.revision);
  const after = Number(url.searchParams.get("after") ?? "0");
  if (!Number.isInteger(after) || after < 0 || after > 400) throw agentXError("CONFIG_INVALID", "after: a journal position");
  // The websites the run asked for: the host and where the ask stands, nothing else (a card is decided on the decisions page, by an administrator).
  const asks = (await listHostAsks(setup, caller.orgId, found.name, ["open", "approved", "refused"])).slice(0, 50).map((ask) => ({ host: ask.host, status: ask.state, ...(ask.journalN === undefined ? {} : { journalN: ask.journalN }), ...(ask.from === undefined ? {} : { from: ask.from }) }));
  if (state.pointer === undefined) return new StatusReply(200, { entries: [], status: state.view.status, hostAsks: asks });
  const entries = await readSetupJournal(setup, { orgId: caller.orgId, project: found.name, taskId: state.pointer.taskId }, after);
  return new StatusReply(200, { status: state.view.status, entries, hostAsks: asks });
}
