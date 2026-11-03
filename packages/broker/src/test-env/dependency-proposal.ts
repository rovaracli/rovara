// Test services, slice 1 T3 (design test-services.md 3.2 to 3.4): turning what the detectors found (CANDIDATES, in a setup draft) into PROPOSED dependencies.
//
// The worker's draft is untrusted, so the BROKER decides here: each candidate goes through `chooseBacking` (the deterministic chooser, place "task_check" and again "working"), and only a candidate that gets REAL software
// from the signed catalog becomes a dependency of the proposal (slice 1 starts nothing else). Everything in a proposed dependency is made from the catalog entry the chooser picked, the candidate's family and kind, and the
// files and lines the detector cited; no text from the repository is copied (a name is a fixed word for a known family, a variable name comes from the catalog's own templates). What cannot be backed yet is counted in one
// fixed note, never described. A person still approves the proposal on a card; nothing here approves anything.
import { TestEnvDependenciesSchema, TestEnvDependencySchema, type TestEnvDependency, type TestEnvDependencyCandidate, type VerifiedCatalog } from "@agentx/contracts";
import { chooseBacking, effectiveAllowedBackings } from "./backing-choice.js";

export const DEPENDENCIES_NOT_PROPOSED_NOTE = "Some dependencies were found that Rovara cannot start yet. They are not part of the proposal.";
export const DEPENDENCIES_NO_CATALOG_NOTE = "Dependencies were found, but Rovara's image list could not be read, so none are proposed.";
export const DEPENDENCIES_LEFT_OUT_NOTE = "The dependencies found could not be proposed together, so none are proposed.";

/** What people see for the families Rovara knows; any other family shows its id (which passed the family pattern). */
const FAMILY_NAMES: Readonly<Record<string, string>> = {
  postgres: "Postgres", mysql: "MySQL", mariadb: "MariaDB", mongodb: "MongoDB", redis: "Redis", memcached: "Memcached", rabbitmq: "RabbitMQ", kafka: "Kafka", elasticsearch: "Elasticsearch", opensearch: "OpenSearch", smtp: "Mail catcher",
};

const idOfFamily = (family: string): string | undefined => {
  const id = family.replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 40).replace(/-+$/u, "");
  return /^[a-z][a-z0-9-]{0,39}$/u.test(id) ? id : undefined;
};

export interface DependencyProposalContext {
  /** The signed catalog (`serviceCatalogSourceOf`); undefined when it could not be read. */
  catalog: VerifiedCatalog | undefined;
  edition: "public" | "enterprise";
  projectId: string;
  prodDeny: { accountIds: string[]; hosts: string[]; arnPrefixes: string[] };
}

export interface DependencyProposal { dependencies: TestEnvDependency[]; notes: string[] }

/** The proposed dependencies for a draft's candidates, and the fixed notes for what was left out. Never throws; a candidate that does not make a valid dependency is left out and counted. */
export function proposeDependencies(candidates: readonly TestEnvDependencyCandidate[], context: DependencyProposalContext): DependencyProposal {
  if (candidates.length === 0) return { dependencies: [], notes: [] };
  const catalog = context.catalog;
  if (catalog === undefined) return { dependencies: [], notes: [DEPENDENCIES_NO_CATALOG_NOTE] };
  const proposed: TestEnvDependency[] = [];
  let leftOut = 0;
  for (const candidate of candidates) {
    try {
      const one = proposeOne(candidate, catalog, context);
      if (one === undefined) leftOut += 1;
      else proposed.push(one);
    } catch {
      leftOut += 1;
    }
  }
  // The list as a whole must be one the contract accepts (unique ids, aliases and variables; at most 12 started). If it is not, nothing is proposed: a partial list would pick winners by position.
  if (proposed.length > 0 && !TestEnvDependenciesSchema.safeParse(proposed).success) return { dependencies: [], notes: [DEPENDENCIES_LEFT_OUT_NOTE] };
  return { dependencies: proposed, notes: leftOut > 0 ? [DEPENDENCIES_NOT_PROPOSED_NOTE] : [] };
}

function proposeOne(candidate: TestEnvDependencyCandidate, catalog: VerifiedCatalog, context: DependencyProposalContext): TestEnvDependency | undefined {
  const id = idOfFamily(candidate.family);
  if (id === undefined) return undefined;
  // Tests that fake it themselves, and anything the chooser would back with something else, are not slice 1's: only real software from the catalog is proposed.
  if (candidate.hints.fakedByTests === true) return undefined;
  let catalogId: string | undefined;
  for (const place of ["task_check", "working"] as const) {
    const chosen = chooseBacking({
      dependency: { family: candidate.family, kind: candidate.kind, major: candidate.hints.version, fakedByTests: false },
      place, edition: context.edition, allowed: effectiveAllowedBackings(undefined), catalog, projectId: context.projectId, projectImages: [], accounts: [], prodDeny: context.prodDeny, fixtures: [], canMakeFake: false, now: 0,
    });
    if (chosen.backing.kind !== "local" || (catalogId !== undefined && catalogId !== chosen.backing.catalogId)) return undefined;
    catalogId = chosen.backing.catalogId;
  }
  const entry = catalog.entries.find((item) => item.id === catalogId);
  if (entry === undefined || catalogId === undefined) return undefined;
  const config = entry.family === "postgres" && candidate.hints.initFiles !== undefined && candidate.hints.initFiles.length > 0 ? { initFiles: candidate.hints.initFiles.slice(0, 4) } : {};
  const parsed = TestEnvDependencySchema.safeParse({
    id, name: FAMILY_NAMES[candidate.family] ?? candidate.family, kind: candidate.kind, family: candidate.family,
    found: candidate.evidence.slice(0, 8).map((item) => ({ path: item.path, line: item.line })),
    usedBy: ["integration"],
    backing: { kind: "local", catalogId, config },
    connect: { env: Object.entries(entry.connect.templates).map(([name, template]) => ({ name, template })), hostAliases: [...entry.connect.defaultAliases] },
    seeds: [], reset: "fresh_per_round",
  });
  return parsed.success ? parsed.data : undefined;
}
