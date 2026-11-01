// Live interaction F4: "Propose this change". A diagnosis never changes a setting: its `settings_change` proposal is text. When a person with the right role presses "Propose this change", the broker
// raises that one change through the ORDINARY settings route, as that person, after it has read everything again:
//   - the proposal is read from the stored diagnosis (never from the request) and is checked against the allow-list and the deny-list AGAIN (owner Q8: never secrets, budgets, roles, approval rules,
//     tier-0 included, egress, model endpoints or MCP servers), whatever was stored;
//   - the person must still be allowed to diagnose the error, and be a maintainer of the project (the ordinary route checks that too);
//   - `from` must still be what the setting is NOW (a stale proposal is refused: nothing is applied from a diagnosis that has been overtaken);
//   - every citation is read again: a runbook Rovara ships, or a file of one of the project's repositories at the commit named, and its quote must be there. One that cannot be read, or that does not
//     hold, refuses the change (fail closed: an unchecked claim is not evidence).
// Where the ordinary route applies a change at once for a maintainer, so does the press, as the maintainer, under the revision just read; where it asks an administrator, it would ask here too (the
// settings a diagnosis may name never need one). Each target has one path into its route; a target with none (the whole `playbook`, `connector` and `model_access`) cannot be proposed.
import {
  DIAGNOSIS_REFUSALS, DiagnosisProposeBodySchema, agentXError, diagnosisPathDenied, diagnosisPrefillAllowed, diagnosisRunbook, parseDiagnosisCitation,
  type CodeSettings, type DiagnosisProposal, type OrgId, type ProjectSettingsBody,
} from "@agentx/contracts";
import { auditDiagnosisProposalRaised } from "../audit/events.js";
import { auditActorOf } from "../audit/plan3-hooks.js";
import type { DeveloperCaller } from "../aws/developer-routes.js";
import type { StatusReply } from "../aws/status-reply.js";
import type { UpdateProjectSettingsOptions } from "../org/project-settings.js";
import { auditDiagnosis } from "./audit.js";
import { diagnosisSubjectFor, maintainerOf } from "./authority.js";
import type { DiagnosisCoreDependencies } from "./light.js";
import { readDiagnosisRecord, readDiagnosisRequest } from "./store.js";

type SettingsChange = Extract<DiagnosisProposal, { kind: "settings_change" }>;

/** What proposing needs: the project's settings as they are now, and the ordinary routes that change them, each as the caller. */
export interface DiagnosisProposePorts {
  /** The project's latest definition: its revision, its dev container and its repositories (the places a citation may name). Undefined when it cannot be read. */
  project(orgId: OrgId, project: string): Promise<{ revision: number; devcontainer?: { repository: string; configPath?: string | undefined } | undefined; repositories: ReadonlyArray<{ name: string; url: string }> } | undefined>;
  /** The project's code settings, read now. */
  codeSettings(orgId: OrgId, project: string): Promise<CodeSettings>;
  /** `PUT …/code-settings`, as the caller. */
  putCodeSettings(caller: DeveloperCaller, project: string, body: unknown): Promise<StatusReply>;
  /** `PUT …/settings`, as the caller. */
  updateSettings(caller: DeveloperCaller, project: string, body: ProjectSettingsBody, options: UpdateProjectSettingsOptions): Promise<unknown>;
  /** A file of one of the project's repositories at a commit (undefined: not there; throws: GitHub could not answer). Absent: a repository citation cannot be read again. */
  readFile?: ((orgId: OrgId, repositoryUrl: string, path: string, commit: string, options: { timeoutMs: number }) => Promise<string | undefined>) | undefined;
}

/** How long a citation's file read may take. */
const CITATION_READ_TIMEOUT_MS = 8_000;

/** Which targets have a path into an ordinary route. Everything else is explain-and-link only. */
export const PROPOSABLE: ReadonlyArray<{ target: SettingsChange["target"]; path: string }> = [
  { target: "code_settings", path: "mergeMethod" },
  { target: "setup_item", path: "devcontainer.configPath" },
];

/** Whether a citation holds now. `unread`: it could not be read (no reader, GitHub down, a repository the project does not have); `wrong`: it was read and the quote is not there. */
async function citationState(ports: DiagnosisProposePorts, orgId: OrgId, project: NonNullable<Awaited<ReturnType<DiagnosisProposePorts["project"]>>>, citation: string): Promise<"verified" | "unread" | "wrong"> {
  const parsed = parseDiagnosisCitation(citation);
  if (parsed === undefined) return "wrong";
  if (parsed.kind === "doc") {
    const runbook = diagnosisRunbook(parsed.id);
    if (runbook === undefined) return "wrong";
    return parsed.quote === undefined || runbook.text.includes(parsed.quote) ? "verified" : "wrong";
  }
  const repository = project.repositories.find((candidate) => candidate.name === parsed.repository);
  if (repository === undefined || ports.readFile === undefined) return "unread";
  try {
    const text = await ports.readFile(orgId, repository.url, parsed.path, parsed.commit, { timeoutMs: CITATION_READ_TIMEOUT_MS });
    if (text === undefined) return "wrong";
    return parsed.quote === undefined || text.includes(parsed.quote) ? "verified" : "wrong";
  } catch {
    return "unread";
  }
}

/** Reads every citation of a change again. All must hold: one that cannot be read or does not hold refuses the change. */
async function citationsHold(ports: DiagnosisProposePorts, orgId: OrgId, project: NonNullable<Awaited<ReturnType<DiagnosisProposePorts["project"]>>>, change: SettingsChange): Promise<"ok" | "unread" | "wrong"> {
  const states = await Promise.all(change.citations.map((citation) => citationState(ports, orgId, project, citation)));
  if (states.includes("wrong")) return "wrong";
  return states.includes("unread") || states.length === 0 ? "unread" : "ok";
}

/**
 * `POST /v1/app/diagnoses/{id}/propose`: raises the settings change at `index` through the ordinary route, as the person. Answers what was raised and nothing of the setting's value. A repeat of the
 * request id is the ordinary route's repeat of its own request: nothing is applied twice.
 */
export async function proposeDiagnosisChange(
  deps: DiagnosisCoreDependencies, ports: DiagnosisProposePorts | undefined, caller: DeveloperCaller, diagnosisId: string, value: unknown,
): Promise<{ diagnosisId: string; index: number; target: string; outcome: "applied" }> {
  if (!deps.enabled) throw agentXError("NOT_FOUND", "route not found");
  const body = DiagnosisProposeBodySchema.safeParse(value);
  if (!body.success) throw agentXError("CONFIG_INVALID", "a proposal needs a request ID and the number of the change");
  if (ports === undefined) throw agentXError("NOT_FOUND", DIAGNOSIS_REFUSALS.noPath);
  const orgId = caller.orgId;
  const request = await readDiagnosisRequest(deps, orgId, diagnosisId);
  if (request === undefined || request.state !== "ready") throw agentXError("NOT_FOUND", "route not found");
  const subject = await diagnosisSubjectFor(deps.authority, caller, request.errorRef);
  if (subject === undefined) throw agentXError("NOT_FOUND", "route not found");
  const record = await readDiagnosisRecord(deps, orgId, diagnosisId);
  const proposal = record?.proposals[body.data.index];
  if (proposal === undefined || proposal.kind !== "settings_change") throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.notProposal);

  // Read again, whatever was stored: the allow-list (path and value), the deny-list, and a path into an ordinary route.
  if (!diagnosisPrefillAllowed(proposal.target, proposal.path, proposal.from, proposal.to) || diagnosisPathDenied(proposal.path)) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.notProposal);
  if (!PROPOSABLE.some((entry) => entry.target === proposal.target && entry.path === proposal.path)) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.noPath);
  // The change is to the project the error is about; the person must maintain it (the ordinary route asks too).
  if (await maintainerOf(deps.authority, caller, subject.project) === undefined) throw agentXError("FORBIDDEN", DIAGNOSIS_REFUSALS.roleNeeded);

  const project = await ports.project(orgId, subject.project);
  if (project === undefined) throw agentXError("RUNTIME_UNAVAILABLE", DIAGNOSIS_REFUSALS.staleProposal);
  // `from` is what the setting is now, or the proposal is overtaken.
  let apply: () => Promise<unknown>;
  if (proposal.target === "code_settings") {
    const current = await ports.codeSettings(orgId, subject.project);
    if (proposal.from !== current.mergeMethod) throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.staleProposal);
    apply = () => ports.putCodeSettings(caller, subject.project, { requestId: body.data.requestId, expectedRevision: current.revision, mergeMethod: proposal.to });
  } else {
    const container = project.devcontainer;
    if (container === undefined || (container.configPath ?? null) !== proposal.from || typeof proposal.to !== "string") throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.staleProposal);
    apply = () => ports.updateSettings(caller, subject.project, { requestId: body.data.requestId, expectedRevision: project.revision, devcontainer: { repository: container.repository, configPath: proposal.to as string } }, { origin: "agent" });
  }
  // Every citation is read again, the last thing before the change is raised.
  const held = await citationsHold(ports, orgId, project, proposal);
  if (held === "unread") throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.citationsUnchecked);
  if (held === "wrong") throw agentXError("CONFIG_INVALID", DIAGNOSIS_REFUSALS.citationsWrong);

  await apply();
  await auditDiagnosis(deps.audit, () => auditDiagnosisProposalRaised({
    orgId, actor: auditActorOf(caller.developerId), occurredAt: new Date(deps.now()).toISOString(), occurrence: `${diagnosisId}:${body.data.requestId}`,
    diagnosisId, proposalKind: "settings_change", approvalId: body.data.requestId,
  }));
  return { diagnosisId, index: body.data.index, target: proposal.target, outcome: "applied" };
}
