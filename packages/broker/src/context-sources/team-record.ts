// E2/E7: the two interfaces this lane has with the Team record (design 3.8). The lane emits what it saw and asks the record to search; it never keeps
// source text itself. Until the Team record's own build lands, `TeamRecordSearch` answers nothing and `TeamRecordSink` drops events, so this lane ships
// without waiting for it. The interfaces are the design's, unchanged: switching to the real ones is an import change only.
import type { CitationStanding } from "@agentx/contracts";

/** What the broker emits after each context call, one per item (design 3.8). */
export interface ContextItemSeen {
  orgId: string;
  projectId: string;
  taskId: string;
  stage: string;
  sourceId: string;
  system: string;
  itemRef: string;
  url?: string | undefined;
  title: string;
  /** What the source said about who can see the item, as the connector reports it. Unknown is `null`: the record then treats the item as project-only. */
  permissionSnapshot: unknown;
  fetchedAt: string;
  contentDigest: string;
  /** Present only if the source's retention allows storing; live facts are already removed from it. */
  content?: string | undefined;
  standing: CitationStanding;
}

/** Fire and forget. A failure never blocks a task. */
export interface TeamRecordSink {
  seen(item: ContextItemSeen): Promise<void>;
}

export interface TeamRecordHit {
  itemRef: string;
  system: string;
  url?: string | undefined;
  title: string;
  snippet?: string | undefined;
  permissionSnapshot: unknown;
  score: number;
}

export interface TeamRecordSearch {
  search(input: { orgId: string; projectId: string; query: string; sources?: string[] | undefined; asAgentForTask: string; limit: number }): Promise<TeamRecordHit[]>;
}

/** The stand-ins until the Team record lands. */
export const droppingSink: TeamRecordSink = { seen: async () => undefined };
export const emptySearch: TeamRecordSearch = { search: async () => [] };

/** The most hits one search may ask for (design 3.8). */
export const TEAM_SEARCH_LIMIT_MAX = 20;

/** `value` with every key named in `liveFacts` removed at any depth: status, assignee and priority change, and are fetched fresh at display, never stored. */
export function withoutLiveFacts(value: unknown, liveFacts: readonly string[]): unknown {
  if (liveFacts.length === 0) return value;
  const names = new Set(liveFacts.map((name) => name.toLowerCase()));
  const walk = (entry: unknown, depth: number): unknown => {
    if (depth > 12) return entry;
    if (Array.isArray(entry)) return entry.map((item) => walk(item, depth + 1));
    if (typeof entry === "object" && entry !== null) {
      return Object.fromEntries(Object.entries(entry as Record<string, unknown>).filter(([name]) => !names.has(name.toLowerCase())).map(([name, item]) => [name, walk(item, depth + 1)]));
    }
    return entry;
  };
  return walk(value, 0);
}
