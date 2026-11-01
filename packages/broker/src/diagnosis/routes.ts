// Live interaction F2 to F4: the routes a person uses for Fix with agent.
//
//   POST /v1/app/diagnoses                    ask for a light diagnosis of the error the app showed (body: requestId, errorRef)
//   GET  /v1/app/diagnoses/{id}               where it is and, once ready, its proposals
//
// While the `fd` switch is off the dependencies are absent and every one of these is NOT_FOUND, as if it did not exist.
import { agentXError } from "@agentx/contracts";
import { StatusReply } from "../aws/status-reply.js";
import { diagnosisStatusFor, startLightDiagnosis, type DiagnosisCaller, type DiagnosisDependencies } from "./light.js";

export type DiagnosisRouteDependencies = DiagnosisDependencies;

const LIST_PATH = "/v1/app/diagnoses";
const ONE_PATH = /^\/v1\/app\/diagnoses\/(dgn_[0-9a-z]{20})$/u;

export const isDiagnosisPath = (pathname: string): boolean => pathname === LIST_PATH || ONE_PATH.test(pathname);

/**
 * Answers a diagnosis route, or undefined for a path that is not one. `body` is read only for a POST (a lazy read, so a GET never parses one).
 */
export async function routeDiagnosisRequest(
  deps: DiagnosisRouteDependencies | undefined, caller: DiagnosisCaller, method: string, pathname: string, body: () => unknown,
): Promise<StatusReply | object | undefined> {
  if (!isDiagnosisPath(pathname)) return undefined;
  if (deps === undefined || !deps.enabled) throw agentXError("NOT_FOUND", "route not found");
  const who: DiagnosisCaller = { orgId: caller.orgId, developerId: caller.developerId };
  if (pathname === LIST_PATH) {
    if (method !== "POST") throw agentXError("NOT_FOUND", "route not found");
    const status = await startLightDiagnosis(deps, who, body());
    return new StatusReply(status.state === "queued" ? 202 : 200, status);
  }
  if (method !== "GET") throw agentXError("NOT_FOUND", "route not found");
  return diagnosisStatusFor(deps, who, ONE_PATH.exec(pathname)![1]!);
}
