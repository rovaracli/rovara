// Meta repo lane F (F1): the broker's wiring of the intake routes (`rovara-code`-style: one module, so the router needs two lines). `routeIntake` answers a reply for an intake path and
// undefined for any other path. The engine's ports are built from the developer API's own dependencies, so the role check, the payer and the budget are the start's own.
import { agentXError } from "@rovara-code/contracts";
import { INTAKE_PATH, routeIntakeRequest, type IntakeRouteDependencies } from "../../intake/routes.js";
import { intakePortsOf } from "../../intake/wiring.js";
import type { StatusReply } from "../status-reply.js";
import { agentRunStarterOf, codeIntentDependenciesOf } from "./dependencies.js";
import { projectRoleForRoute } from "./project-members.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { jsonBody } from "./organization.js";
import type { DeveloperCaller, DeveloperRouteDependencies } from "./types.js";

/** The intake routes' dependencies, or undefined where agents are not set up (a start needs them). */
export function intakeRouteDependenciesOf(deps: DeveloperRouteDependencies): IntakeRouteDependencies | undefined {
  const starter = agentRunStarterOf(deps);
  if (starter === undefined) return undefined;
  return {
    ports: intakePortsOf({
      documentClient: deps.documentClient, tableName: deps.tableName, now: deps.now, starter,
      intentDependenciesFor: (who) => codeIntentDependenciesOf(deps, who),
      ...(deps.teamRecord === undefined ? {} : { trackerLinks: deps.teamRecord.table }),
    }),
    projectFor: (who, rawName) => projectRoleForRoute(deps, who, rawName),
  };
}

/** `GET|POST|PUT /v1/app/projects/{project}/intake...`: the reply, or undefined when the path is not an intake path. */
export async function routeIntake(deps: DeveloperRouteDependencies, caller: DeveloperCaller, request: AdaptedHttpRequest, url: URL): Promise<StatusReply | undefined> {
  const match = INTAKE_PATH.exec(url.pathname);
  if (match === null) return undefined;
  const intake = intakeRouteDependenciesOf(deps);
  if (intake === undefined) throw agentXError("NOT_FOUND", "task intake is not set up in this deployment");
  return routeIntakeRequest(intake, caller, request.method, match, request.method === "GET" ? undefined : jsonBody(request));
}
