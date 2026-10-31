// Knowledge resolver (K1, C5a): the "what the agent loaded" record, built from the resolver's records.
// References only: no rule text, no skill text. Loaded items come first; skipped and available ones follow until the record is full, and the
// counts of what was left out are kept so the panel can say so.
import {
  LOADED_KNOWLEDGE_EVENT_FIELD,
  LoadedKnowledgeManifestSchema,
  MAX_LOADED_KNOWLEDGE_ITEMS,
  type LoadedKnowledgeItem,
  type LoadedKnowledgeManifest,
} from "@agentx/contracts";
import { inertContextText } from "../context-text.js";
import type { KnowledgeStage } from "./model.js";
import type { KnowledgeRecord, ResolvedKnowledge } from "./resolve.js";

export interface ManifestRepository {
  name: string;
  /** The commit the repository's rules were read from, when they were read from one. */
  commit?: string;
  readAt: "base" | "working";
}

/** A name or path from a repository as bounded text with no hidden characters. */
const clean = (value: string, max: number): string => inertContextText(value).text.slice(0, max);

const itemOf = (record: KnowledgeRecord): LoadedKnowledgeItem => ({
  layer: record.layer,
  ...(record.repo === undefined ? {} : { repo: clean(record.repo, 200) }),
  ...(record.path === undefined ? {} : { path: clean(record.path, 400) }),
  scopeDir: clean(record.scopeDir, 400),
  format: record.format.slice(0, 40),
  ...(record.activation === undefined ? {} : { activation: record.activation }),
  ...(record.patterns === undefined ? {} : { patterns: record.patterns.slice(0, 20).map((pattern) => clean(pattern, 256)) }),
  ...(record.name === undefined ? {} : { name: clean(record.name, 200) }),
  bytes: Math.min(record.bytes, 10_000_000),
  ...(record.digest === undefined ? {} : { digest: record.digest }),
  ...(record.fileDigest === undefined ? {} : { fileDigest: record.fileDigest }),
  ...(record.readAt === undefined ? {} : { readAt: record.readAt }),
  ...(record.locked === true ? { locked: true as const } : {}),
  status: record.status,
  ...(record.why === undefined ? {} : { why: record.why }),
  ...(record.reason === undefined ? {} : { reason: record.reason }),
});

export function buildLoadedKnowledgeManifest(input: {
  stage: KnowledgeStage;
  resolved: ResolvedKnowledge;
  /** Every record so far, including rules loaded during the run (`MidRunKnowledge.allRecords()`); the resolver's own when absent. */
  records?: readonly KnowledgeRecord[];
  repositories: readonly ManifestRepository[];
  meta?: { name: string; knowledgeCommit: string };
  sources?: readonly { label: string; count: number }[];
}): LoadedKnowledgeManifest {
  const all = (input.records ?? input.resolved.records).map(itemOf);
  const rank = (status: LoadedKnowledgeItem["status"]): number => (status === "loaded" ? 0 : status === "skipped" ? 1 : 2);
  const ordered = all.toSorted((left, right) => rank(left.status) - rank(right.status));
  const items = ordered.slice(0, MAX_LOADED_KNOWLEDGE_ITEMS);
  const left = ordered.slice(MAX_LOADED_KNOWLEDGE_ITEMS);
  const manifest: LoadedKnowledgeManifest = {
    schemaVersion: 1,
    stage: input.stage,
    ...(input.meta === undefined ? {} : { metaRepo: { name: input.meta.name, knowledgeCommit: input.meta.knowledgeCommit } }),
    repos: input.repositories.slice(0, 40).map((repository) => ({ name: repository.name, ...(repository.commit === undefined ? {} : { commit: repository.commit }), readAt: repository.readAt })),
    items,
    omitted: { skipped: left.filter((item) => item.status === "skipped").length, available: left.filter((item) => item.status === "available").length },
    skills: input.resolved.skills,
    skippedSkills: input.resolved.skippedSkills.slice(0, 128),
    sources: (input.sources ?? []).slice(0, 50).map((source) => ({ label: source.label.slice(0, 200), count: Math.min(source.count, 1_000) })),
    budget: input.resolved.budget,
  };
  // A record that does not validate is a bug here; the worker reports nothing rather than something the broker will refuse.
  return LoadedKnowledgeManifestSchema.parse(manifest);
}

/** The progress-event payload that carries a record to the control plane. */
export const loadedKnowledgePayload = (manifest: LoadedKnowledgeManifest): Record<string, unknown> => ({ [LOADED_KNOWLEDGE_EVENT_FIELD]: manifest });
