// TE-2 test support: the report of a proposal's CANDIDATE check, written the way the broker leaves it (a ready workspace, and the record that names the digest, the settings revision and the exact commands it ran).
// The lists are the real ones (`candidateLists` of the stored proposal against the project's latest settings) unless a test hands in others, to play a check that ran something else.
import { INDEX_EXPIRY_ATTRIBUTE, projectPk, type OrgId, type PreparePins, type ProjectCommand } from "@agentx/contracts";
import { CANDIDATE_CHECK_ENTITY, candidateCheckKey, candidateExpiry } from "../../packages/broker/src/org/test-env-candidate.js";
import { isSetupRunProposal } from "../../packages/broker/src/org/test-environment.js";
import { candidateListsChecked } from "../../packages/broker/src/test-env/candidate-commands.js";

interface Db { get(pkOrKey: string | { pk: string; sk: string }, sk?: string): unknown; set(item: Record<string, unknown>): void; find(predicate: (item: Record<string, unknown>) => boolean): Array<Record<string, unknown>> }

export const candidateWorkspaceId = (digest: string): string => `ws-cand-${digest.slice(0, 8)}`;

export function candidatePassed(
  db: Db, input: { orgId: OrgId; project: string; digest: string; developerId: string },
  options: { revision?: number; startedAt?: string; lists?: { setup: ProjectCommand[]; readiness: ProjectCommand[] }; status?: "READY" | "PREPARATION_FAILED" | "PREPARING"; /** The commits the check was prepared at; a setup run's proposal gets the bench's head by default (SU-1 addendum 3). */ pins?: PreparePins | null } = {},
): string {
  const proposal = db.get({ pk: projectPk(input.orgId, input.project), sk: `TESTENV#PROPOSAL#${input.digest}` }) as { environment: never; origin?: string; valueSources?: Array<{ source: unknown }> } | undefined;
  if (proposal === undefined) throw new Error("candidatePassed: no stored proposal for this digest");
  const revisions = db.find((item) => item.entityType === "PROJECT" && (item.definition as { name?: string } | undefined)?.name === input.project) as unknown as Array<{ definition: { revision: number; repositories: Array<{ path: string }>; setup: ProjectCommand[]; readiness: ProjectCommand[] } }>;
  const latest = revisions.sort((a, b) => a.definition.revision - b.definition.revision).at(-1)!.definition;
  const revision = options.revision ?? latest.revision;
  const lists = options.lists ?? candidateListsChecked(proposal.environment, latest);
  const workspaceId = candidateWorkspaceId(input.digest);
  const fromRun = proposal.origin === "setup_run" || isSetupRunProposal(proposal.valueSources ?? []);
  const pins = options.pins === null ? undefined : options.pins ?? (fromRun ? [{ repository: "web", commit: "c".repeat(40) }] : undefined);
  db.set({ pk: `WORKSPACE#${workspaceId}`, sk: "META", status: options.status ?? "READY" });
  db.set({
    ...candidateCheckKey(input.orgId, input.project, input.digest, revision), entityType: CANDIDATE_CHECK_ENTITY, orgId: input.orgId, project: input.project, digest: input.digest, workspaceId, revision,
    startedAt: options.startedAt ?? new Date().toISOString(), startedBy: input.developerId, setup: lists.setup, readiness: lists.readiness, ...(pins === undefined ? {} : { pins }), [INDEX_EXPIRY_ATTRIBUTE]: candidateExpiry(Date.now()),
  });
  return workspaceId;
}
