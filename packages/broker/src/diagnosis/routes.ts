// Live interaction F2 to F4: the routes a person uses for Fix with agent.
//
//   POST /v1/app/diagnoses                    ask for a light diagnosis of the error the app showed (body: requestId, errorRef)
//   GET  /v1/app/diagnoses/{id}               where it is and, once ready, its proposals
//   POST /v1/app/diagnoses/{id}/deep          ask for the deep tier of a light diagnosis that said it needs the code   (deep.ts)
//   POST /v1/app/diagnoses/{id}/propose       "Apply this change" for one settings change, through the ordinary route   (propose.ts)
//
// While the `fd` switch is off the dependencies are absent and every one of these is NOT_FOUND, as if it did not exist.
import { agentXError } from "@rovara-code/contracts";
import { StatusReply } from "../aws/status-reply.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import { startDeepDiagnosis, type DeepDiagnosisPorts } from "./deep.js";
import { proposeDiagnosisChange, type DiagnosisProposePorts } from "./propose.js";
import { diagnosisStatusFor, startLightDiagnosis, type DiagnosisCaller, type DiagnosisDependencies } from "./light.js";

export interface DiagnosisRouteDependencies extends DiagnosisDependencies {
  /** The deep tier's start (a read-only task, started as the person). Absent where agents are not set up: the deep route then says it is not available. */
  deep: DeepDiagnosisPorts | undefined;
  /** The ordinary settings routes "Apply this change" goes through. Absent where they are not set up: the route then says it has no path. */
  propose: DiagnosisProposePorts | undefined;
}

const LIST_PATH = "/v1/app/diagnoses";
const ONE_PATH = /^\/v1\/app\/diagnoses\/(dgn_[0-9a-z]{20})(?:\/(deep|propose))?$/u;

export const isDiagnosisPath = (pathname: string): boolean => pathname === LIST_PATH || ONE_PATH.test(pathname);

/**
 * Answers a diagnosis route, or undefined for a path that is not one. `body` is read only for a POST (a lazy read, so a GET never parses one).
 */
export async function routeDiagnosisRequest(
  deps: DiagnosisRouteDependencies | undefined, caller: DeveloperCaller, method: string, pathname: string, body: () => unknown,
): Promise<StatusReply | object | undefined> {
  if (!isDiagnosisPath(pathname)) return undefined;
  if (deps === undefined || !deps.enabled) throw agentXError("NOT_FOUND", "route not found");
  const who: DiagnosisCaller = { orgId: caller.orgId, developerId: caller.developerId };
  if (pathname === LIST_PATH) {
    if (method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    const status = await startLightDiagnosis(deps, who, body());
    return new StatusReply(status.state === "queued" ? 202 : 200, status);
  }
  const match = ONE_PATH.exec(pathname)!;
  const id = match[1]!;
  if (match[2] === undefined) {
    if (method !== "GET") throw agentXError("NOT_FOUND", "route not found");
    return diagnosisStatusFor(deps, who, id);
  }
  if (method !== "POST") throw agentXError("NOT_FOUND", "route not found");
  if (match[2] === "propose") return proposeDiagnosisChange(deps, deps.propose, caller, id, body());
  const status = await startDeepDiagnosis(deps, deps.deep, caller, id, body());
  return new StatusReply(status.state === "queued" ? 202 : 200, status);
}
