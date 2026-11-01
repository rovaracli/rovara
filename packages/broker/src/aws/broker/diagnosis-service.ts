// Live interaction F2: the broker's wiring for Fix with agent's light tier, and the three service routes the chat service calls (`/v1/service/diagnoses/*`, the orchestrator role only).
//
//   POST /v1/service/diagnoses/turn           the waiting diagnosis's context, after its requester's right to the error was read again.
//   POST /v1/service/diagnoses/model-access   the turn's model key. WHO PAYS is decided here, from the edition and the tier, and never from a request:
//                                               Public light diagnosis    Rovara pays (support): a key for Rovara's own AI, a fixed small cap, counted against none of the customer's budgets;
//                                               Enterprise light          the customer's own Bedrock and limits: paid like any chat turn of the project, in the requester's name.
//                                             (A deep diagnosis is a task, started and paid like any task; it never comes through here.)
//   POST /v1/service/diagnoses/answered       the answer (or that there is none): read again, stored and audited once.
//
// The service names a diagnosis by its org and id; it can name only one the broker queued itself, and everything that decides what the turn may know or cost (the error, the project, the person)
// comes from the broker's own record of the diagnosis. The switch is OFF by default: with it off nothing is built and every route answers NOT_FOUND.
import { DiagnosisModelAccessRequestSchema, DiagnosisRefSchema, agentXError, type OperationRequester } from "@agentx/contracts";
import type { SessionAccessDependencies } from "../../agent-sessions/access.js";
import { completeDiagnosis, prepareDiagnosisTurn, waitingForKey, type DiagnosisCoreDependencies } from "../../diagnosis/light.js";
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

/** Whether Rovara pays for a light diagnosis: Public only (the customer's own account pays in Enterprise). The only place this is decided. */
export const rovaraPaysForLight = (edition: "enterprise" | "public"): boolean => edition === "public";

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
  const { turnId, model, classifierModel, ...ref } = parsed.data;
  const waiting = await waitingForKey(diagnosis, DiagnosisRefSchema.parse(ref));
  if (waiting === undefined) throw agentXError("NOT_FOUND", "route not found");
  const edition = dependencies.editionPolicy?.edition ?? "public";
  const requester: OperationRequester | undefined = rovaraPaysForLight(edition) ? undefined : { kind: "developer", developerId: waiting.requester, provider: "oidc" };
  return json(await mintChatTurnKey(dependencies, waiting.orgId, waiting.project, requester, { turnId, model, classifierModel }, undefined, rovaraPaysForLight(edition) ? { rovaraPays: true } : {}), request.requestId);
}
