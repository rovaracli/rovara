// Live interaction F2: the broker's wiring for Fix with agent's light tier, and the three service routes the chat service calls (`/v1/service/diagnoses/*`, the orchestrator role only).
//
//   POST /v1/service/diagnoses/turn           the waiting diagnosis's context, after its requester's right to the error was read again.
//   POST /v1/service/diagnoses/model-access   the turn's model key. The company pays, on the company's own AI provider (2026-11-03: Rovara pays for no diagnosis): paid like any chat turn of the project,
//                                             in the requester's name, a key capped at DIAGNOSIS_LIGHT_BUDGET_USD, routed among the sources billed to the company (its own, or Rovara's metered one). With no usable provider the call is refused in fixed words
//                                             and nothing is minted. (A deep diagnosis is a task, started and paid like any task; it never comes through here.)
//   POST /v1/service/diagnoses/answered       the answer (or that there is none): read again, stored and audited once.
//
// The service names a diagnosis by its org and id; it can name only one the broker queued itself, and everything that decides what the turn may know or cost (the error, the project, the person)
// comes from the broker's own record of the diagnosis. The switch is OFF by default: with it off nothing is built and every route answers NOT_FOUND.
import { DiagnosisModelAccessRequestSchema, DiagnosisRefSchema, agentXError, canonicalModelName, type OperationRequester } from "@agentx/contracts";
import type { SessionAccessDependencies } from "../../agent-sessions/access.js";
import type { DeveloperRouteDependencies } from "../developer-routes/types.js";
import { defaultBranchFileReader } from "../../diagnosis/default-branch-file.js";
import type { GitHubTokenScope } from "../../github-app.js";
import { githubScope } from "./scope-helpers.js";
import { completeDiagnosis, prepareDiagnosisTurn, waitingForKey, type DiagnosisCoreDependencies } from "../../diagnosis/light.js";
import { claimDiagnosisKey, claimDiagnosisRetry, recordRetryModel } from "../../diagnosis/store.js";
import { diagnosisEnabled } from "../../diagnosis/switch.js";
import { json } from "../json-reply.js";
import type { AdaptedHttpRequest } from "../lambda.js";
import { parseBody } from "./admin-and-helpers.js";
import type { AwsBrokerDependencies } from "./definitions.js";
import { mintChatTurnKey } from "./model-access.js";
import { requireSlackServiceRole } from "./workspace-preparation.js";

/**
 * What the service routes need, from the broker's dependencies and the session routes' own level dependencies (so "can use" means what it means everywhere else). Undefined while the switch is off.
 */
export function diagnosisServiceDependenciesFor(dependencies: AwsBrokerDependencies, access: SessionAccessDependencies, env: NodeJS.ProcessEnv = process.env): DiagnosisCoreDependencies | undefined {
  if (!diagnosisEnabled(env)) return undefined;
  const table = { documentClient: dependencies.documentClient, tableName: dependencies.tableName };
  return {
    ...table, now: Date.now, enabled: true, authority: { ...table, access },
    audit: { ...table, ...(dependencies.audit === undefined ? {} : { audit: dependencies.audit }) },
    log: (entry) => console.log(JSON.stringify({ component: "broker", ...entry })),
  };
}

/** Installs `dependencies.diagnosisService` from the session routes' level dependencies. Without them (no agents on this install), or with the switch off, nothing is installed. */
export function installDiagnosisService(dependencies: AwsBrokerDependencies, access: SessionAccessDependencies | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (access === undefined) return;
  const installed = diagnosisServiceDependenciesFor(dependencies, access, env);
  if (installed !== undefined) dependencies.diagnosisService = installed;
}

/** DG-1 S2: the route dependency that reads a file at the head of a repository's default branch (needs the three GitHub reads; absent where they are not set up, and then a dev container path is not applied). */
export function diagnosisDefaultBranchFileRoute(dependencies: AwsBrokerDependencies): Pick<DeveloperRouteDependencies, "defaultBranchFileReader"> {
  const github = dependencies.githubPullRequests;
  if (github.getRepositoryIdentity === undefined || github.getDefaultBranchHead === undefined || github.getFileAtCommit === undefined) return {};
  return {
    defaultBranchFileReader: defaultBranchFileReader<GitHubTokenScope>({
      getRepositoryIdentity: (url, scope) => github.getRepositoryIdentity!(url, scope), getDefaultBranchHead: (url, branch, scope) => github.getDefaultBranchHead!(url, branch, scope),
      getFileAtCommit: (url, path, commit, scope, options) => github.getFileAtCommit!(url, path, commit, scope, options),
    }, (orgId) => githubScope(dependencies, orgId)),
  };
}

/**
 * The service routes. Answers undefined for a path that is not a diagnosis route (the caller goes on). Needs the orchestrator role. With the switch off, every diagnosis route is NOT_FOUND.
 */
export async function handleDiagnosisServiceRoute(
  dependencies: AwsBrokerDependencies, diagnosis: DiagnosisCoreDependencies | undefined, request: AdaptedHttpRequest, pathname: string,
): Promise<ReturnType<typeof json> | undefined> {
  if (!/^\/v1\/diagnoses\/(turn|model-access|answered)$/u.test(pathname) || request.method !== "POST") return undefined;
  requireSlackServiceRole(dependencies, request);
  if (diagnosis === undefined) throw agentXError("NOT_FOUND", "route not found");
  const body = parseBody(request.body);
  if (pathname === "/v1/diagnoses/turn") return json(await prepareDiagnosisTurn(diagnosis, body), request.requestId);
  if (pathname === "/v1/diagnoses/answered") return json(await completeDiagnosis(diagnosis, body), request.requestId);
  const parsed = DiagnosisModelAccessRequestSchema.safeParse(body);
  if (!parsed.success) throw agentXError("CONFIG_INVALID", "model access for a diagnosis needs the diagnosis and a turn ID");
  const { turnId, model, classifierModel, retryAfterRefusal, ...ref } = parsed.data;
  const waiting = await waitingForKey(diagnosis, DiagnosisRefSchema.parse(ref));
  if (waiting === undefined) throw agentXError("NOT_FOUND", "route not found");
  const requester: OperationRequester = { kind: "developer", developerId: waiting.requester, provider: "oidc" };
  if (retryAfterRefusal !== true) {
    return json(await mintChatTurnKey(dependencies, waiting.orgId, waiting.project, requester, { turnId, model, classifierModel }, undefined, { diagnosis: { claimKey: (chosen) => claimDiagnosisKey(diagnosis, waiting.orgId, waiting.diagnosisId, chosen) } }), request.requestId);
  }
  // QA6-14: the service says the company's AI provider refused the model the first key was for (the broker trusts the slack-service role for that; it cannot see the call). One retry per diagnosis, only after a first
  // key: the refused model is left out of THIS diagnosis's choice and nothing else. It is never written to the install-wide usable-models record: that learning belongs to the worker's learner, which reads a distinct
  // "not available for this account" signal, and a refusal seen here (an expired or not-yet-live key, say) must not drop a working model for every company. Nothing in the request names the model: the broker kept it from the first key.
  const retry = await claimDiagnosisRetry(diagnosis, waiting.orgId, waiting.diagnosisId);
  if (retry === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "this diagnosis already had its retry");
  const { rejected } = retry;
  return json(await mintChatTurnKey(dependencies, waiting.orgId, waiting.project, requester, { turnId, model, classifierModel }, undefined, {
    diagnosis: { claimKey: async (chosen) => { if (chosen !== undefined) await recordRetryModel(diagnosis, waiting.orgId, waiting.diagnosisId, chosen); return true; }, ...(rejected === undefined ? {} : { avoid: canonicalModelName(rejected.model) }) },
  }), request.requestId);
}
